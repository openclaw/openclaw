import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const workflow = parse(
  fs.readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8"),
) as {
  jobs: { windows: { steps: { name: string; run?: string }[] } };
};
const run = workflow.jobs.windows.steps.find((step) => step.name === "Run Testbox")?.run;
if (!run) {
  throw new Error("Missing Windows Testbox run step");
}
// Execute the actual monitor after its ready banner, without contacting Blacksmith.
const banner = 'echo "============================================"';
const monitor = run.slice(run.lastIndexOf(banner) + banner.length);

function runMonitor(options: {
  rows?: string;
  ports?: string;
  activeUntil?: number;
  marker?: { observedAt: number; modifiedAt: number };
  discoveryExit?: number;
  netstatExit?: number;
}) {
  const dir = createTempDir("openclaw-windows-idle-");
  fs.writeFileSync(path.join(dir, "connections"), options.rows ?? "");
  const markerSeed = path.join(dir, "marker-seed");
  fs.writeFileSync(markerSeed, "");
  const markerTime = options.marker?.modifiedAt ?? 1000;
  fs.utimesSync(markerSeed, markerTime, markerTime);
  return spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `
clock=1000
runner_ssh_port=64004
idle_timeout=1
trap 'printf "monitor_clock=%s\\n" "$clock"' EXIT
date() { printf '%s\\n' "$clock"; }
sleep() {
  clock=$((clock + 30))
  if [ "$clock" = "$MARKER_AT" ]; then cp -p "$HOME/marker-seed" "$HOME/.testbox-last-activity"; fi
  if [ "$clock" -gt 1300 ]; then return 90; fi
}
pwsh() { printf '%s' "$LOCAL_PORTS"; return "$DISCOVERY_EXIT"; }
netstat() {
  if [ "$clock" -le "$ACTIVE_UNTIL" ]; then command cat "$HOME/connections"; fi
  return "$NETSTAT_EXIT"
}
${monitor}`,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        HOME: dir,
        LOCAL_PORTS: options.ports ?? "22",
        ACTIVE_UNTIL: String(options.activeUntil ?? 1090),
        MARKER_AT: String(options.marker?.observedAt ?? 0),
        DISCOVERY_EXIT: String(options.discoveryExit ?? 0),
        NETSTAT_EXIT: String(options.netstatExit ?? 0),
      },
    },
  );
}

describe.skipIf(process.platform === "win32")("native Windows Testbox idle monitor", () => {
  it.each([
    { name: "IPv4", ports: "22", local: "172.16.0.2:22" },
    { name: "IPv6", ports: "22", local: "[2001:db8::1]:22" },
    { name: "a second non-default listener", ports: "2201|2202", local: "172.16.0.2:2202" },
  ])("keeps $name SSH active, then expires after disconnect", ({ ports, local }) => {
    const result = runMonitor({
      ports,
      rows: `  TCP    ${local}    192.0.2.1:51000    ESTABLISHED\r\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("monitor_clock=1150");
    expect(result.stdout).toContain("Idle timeout reached (1 minutes). Shutting down.");
  });

  it("does not count listeners, foreign ports, port prefixes, or closed connections as activity", () => {
    const result = runMonitor({
      rows: [
        "  TCP    0.0.0.0:22       0.0.0.0:0           LISTENING",
        "  TCP    172.16.0.2:2222  192.0.2.1:51000     ESTABLISHED",
        "  TCP    172.16.0.2:51000 192.0.2.1:64004     ESTABLISHED",
        "  TCP    172.16.0.2:51001 192.0.2.1:22        ESTABLISHED",
        "  TCP    [2001:db8::1]:22 [2001:db8::2]:51000 TIME_WAIT",
        "",
      ].join("\r\n"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("monitor_clock=1060");
  });

  it.each([
    { name: "a command between polls", modifiedAt: 1015, expectedClock: 1090 },
    { name: "an old command", modifiedAt: 970, expectedClock: 1060 },
  ])(
    "uses the marker mtime for $name without keeping the lease alive forever",
    ({ modifiedAt, expectedClock }) => {
      const result = runMonitor({ marker: { observedAt: 1030, modifiedAt } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`monitor_clock=${expectedClock}`);
    },
  );

  it.each([
    { name: "listener discovery", discoveryExit: 7, expectedExit: 7 },
    { name: "connection enumeration", netstatExit: 9, expectedExit: 9 },
  ])(
    "reports $name failures instead of classifying them as idle",
    ({ expectedExit, ...options }) => {
      const result = runMonitor(options);
      expect(result.status, result.stderr).toBe(expectedExit);
      expect(result.stdout).not.toContain("Idle timeout reached");
    },
  );
});

describe.skipIf(process.platform !== "win32")("native Windows Testbox OpenSSH admission", () => {
  it("qualifies supported installations and rejects unsafe or changing service owners", () => {
    const dir = createTempDir("openclaw-windows-openssh-");
    const fixture = path.join(dir, "admission.ps1");
    fs.writeFileSync(
      fixture,
      String.raw`param([string]$Resolver)
$ErrorActionPreference = 'Stop'
. $Resolver
function Assert($Condition, $Name) { if (-not $Condition) { throw "Admission fixture failed: $Name" } }
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$aclCases = @(
  @{ Name='empty'; Sddl='O:BAG:SYD:'; Expected='safe' },
  @{ Name='system owner'; Sddl='O:SYG:SYD:(A;;FA;;;SY)'; Expected='safe' },
  @{ Name='installer owner'; Sddl=('O:' + $trustedInstaller + "G:SYD:(A;;FA;;;$trustedInstaller)"); Expected='safe' },
  @{ Name='outsider owner'; Sddl='O:BUG:SYD:'; Expected='unsafe' },
  @{ Name='null DACL'; Sddl='O:BAG:SY'; Expected='unsafe' },
  @{ Name='signed generic read'; Sddl='O:BAG:SYD:(A;;GR;;;BU)'; Expected='safe' },
  @{ Name='generic execute'; Sddl='O:BAG:SYD:(A;;GX;;;BU)'; Expected='safe' },
  @{ Name='generic write'; Sddl='O:BAG:SYD:(A;;GW;;;BU)'; Expected='unsafe' },
  @{ Name='generic all'; Sddl='O:BAG:SYD:(A;;GA;;;BU)'; Expected='unsafe' },
  @{ Name='mixed generic and write'; Sddl='O:BAG:SYD:(A;;0x80000002;;;BU)'; Expected='unsafe' },
  @{ Name='inherit only'; Sddl='O:BAG:SYD:(A;OICIIO;GA;;;CO)'; Expected='safe' },
  @{ Name='inherited applying'; Sddl='O:BAG:SYD:(A;ID;GW;;;BU)'; Expected='unsafe' },
  @{ Name='no propagate applies'; Sddl='O:BAG:SYD:(A;OICINP;GW;;;BU)'; Expected='unsafe' },
  @{ Name='delete child'; Sddl='O:BAG:SYD:(A;;0x00000040;;;BU)'; Expected='unsafe' },
  @{ Name='change DACL'; Sddl='O:BAG:SYD:(A;;0x00040000;;;BU)'; Expected='unsafe' },
  @{ Name='change owner'; Sddl='O:BAG:SYD:(A;;WO;;;BU)'; Expected='unsafe' },
  @{ Name='append'; Sddl='O:BAG:SYD:(A;;0x4;;;BU)'; Expected='unsafe' },
  @{ Name='extended attributes'; Sddl='O:BAG:SYD:(A;;0x10;;;BU)'; Expected='unsafe' },
  @{ Name='attributes'; Sddl='O:BAG:SYD:(A;;0x100;;;BU)'; Expected='unsafe' },
  @{ Name='delete'; Sddl='O:BAG:SYD:(A;;0x10000;;;BU)'; Expected='unsafe' },
  @{ Name='deny does not cancel allow'; Sddl='O:BAG:SYD:(D;;GA;;;BU)(A;;GW;;;BU)'; Expected='unsafe' }
)
foreach ($case in $aclCases) {
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($case.Sddl)
  Assert ((Get-OpenSshAclDisposition $descriptor $true) -eq $case.Expected) $case.Name
}
Assert ((Get-OpenSshAclDisposition $null $true) -eq 'unknown') 'missing descriptor'
$outsider = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
foreach ($ace in @(
  [Security.AccessControl.CommonAce]::new(0, 0, 0x40000000, $outsider, $true, $null),
  [Security.AccessControl.ObjectAce]::new(0, 0, 1, $outsider, 0, [guid]::Empty, [guid]::Empty, $false, $null),
  [Security.AccessControl.CommonAce]::new(0, 0, 0x02000000, $outsider, $false, $null)
)) {
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new('O:BAG:SYD:')
  $descriptor.DiscretionaryAcl.InsertAce(0, $ace)
  Assert ((Get-OpenSshAclDisposition $descriptor $true) -eq 'unknown') 'unsupported applying ACE'
}

# One process supplies read-only OS observations; the resolver must never execute a binary.
$env:WINDIR = 'C:\Windows'
$env:ProgramFiles = 'C:\Program Files'
function Get-CimInstance($ClassName, $Filter) {
  if ($script:case['ReadError']) { throw 'private diagnostic details' }
  if ($ClassName -eq 'Win32_Service') {
    $script:serviceReads++
    if ($script:case['MissingService']) { return $null }
    $value = @{ State='Running'; StartName='LocalSystem'; ProcessId=42; PathName='"' + $script:sshd + '"' }
    if ($script:case['Bare']) { $value.PathName = $script:sshd }
    if ($script:case['Command']) { $value.PathName = $script:case['Command'] }
    if ($script:case['Service']) { foreach ($k in $script:case['Service'].Keys) { $value[$k] = $script:case['Service'][$k] } }
    if ($script:serviceReads -eq 2 -and $script:case['ChangeService']) { $value[$script:case['ChangeService']] = $script:case['ChangeValue'] }
    if ($script:case['MultipleServices']) { [pscustomobject]$value }
    return [pscustomobject]$value
  }
  $script:processReads++
  Assert ($Filter -eq 'ProcessId=42') 'exact process lookup'
  if ($script:case['MissingProcess']) { return $null }
  $value = @{ ExecutablePath=$script:sshd; CreationDate='2026-01-01T00:00:00Z' }
  if ($script:case['Process']) { foreach ($k in $script:case['Process'].Keys) { $value[$k] = $script:case['Process'][$k] } }
  if ($script:processReads -eq 2 -and $script:case['ChangeProcess']) { $value[$script:case['ChangeProcess']] = $script:case['ChangeValue'] }
  return [pscustomobject]$value
}
function Invoke-CimMethod($InputObject, $MethodName) {
  Assert ($MethodName -eq 'GetOwnerSid') 'owner method'
  if ($script:case['OwnerFailure']) { return @{ ReturnValue=2; Sid='S-1-5-18' } }
  return @{ ReturnValue=0; Sid=$(if ($script:case['OtherOwner']) { 'S-1-5-32-545' } else { 'S-1-5-18' }) }
}
function Get-Item($LiteralPath, [switch]$Force) {
  $script:items.Add($LiteralPath)
  if ($script:case['MissingKeygen'] -and $LiteralPath.EndsWith('ssh-keygen.exe')) { throw 'missing' }
  $directory = -not $LiteralPath.EndsWith('.exe')
  $attributes = if ($directory) { [IO.FileAttributes]::Directory } else { [IO.FileAttributes]::Normal }
  if ($LiteralPath -eq $script:case['Reparse']) { $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint }
  if ($script:case['KeygenDirectory'] -and $LiteralPath.EndsWith('ssh-keygen.exe')) { $directory = $true }
  return @{ Attributes=$attributes; PSIsContainer=$directory }
}
function Get-Acl($LiteralPath) {
  $script:acls.Add($LiteralPath)
  if ($script:case['AclError']) { throw 'unreadable descriptor' }
  $sddl = if ($script:case['UnsafeAcl'] -eq $LiteralPath) { 'O:BAG:SYD:(A;;GW;;;BU)' } else { 'O:BAG:SYD:(A;;GRGX;;;BU)' }
  $acl = [pscustomobject]@{ Descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl) }
  $acl | Add-Member ScriptMethod GetSecurityDescriptorBinaryForm {
    $bytes = [byte[]]::new($this.Descriptor.BinaryLength)
    $this.Descriptor.GetBinaryForm($bytes, 0)
    return ,$bytes
  } -PassThru
}
function Get-AuthenticodeSignature($LiteralPath) {
  $script:signatures.Add($LiteralPath)
  $certificate = [pscustomobject]@{}
  $certificate | Add-Member ScriptMethod GetNameInfo {
    param($Type, $Issuer)
    Assert ($Type -eq [Security.Cryptography.X509Certificates.X509NameType]::SimpleName -and -not $Issuer) 'signer lookup'
    if ($script:case['Signer']) { return $script:case['Signer'] }
    return 'Microsoft Corporation'
  }
  return @{ Status=$(if ($script:case['InvalidSignature'] -eq $LiteralPath) { 'NotSigned' } else { 'Valid' });
    SignerCertificate=$(if ($script:case['MissingSigner']) { $null } else { $certificate }) }
}
$inbox = 'C:\Windows\System32\OpenSSH'
$program = 'C:\Program Files\OpenSSH'
$win64 = 'C:\Program Files\OpenSSH-Win64'
$cases = @(
  @{ Name='inbox quoted'; Directory=$inbox; Accept=$true },
  @{ Name='inbox bare'; Directory=$inbox; Bare=$true; Accept=$true },
  @{ Name='MSI'; Directory=$program; Accept=$true },
  @{ Name='MSI Win64'; Directory=$win64; Accept=$true },
  @{ Name='Microsoft Windows signer'; Signer='Microsoft Windows'; Accept=$true },
  @{ Name='unquoted spaces'; Directory=$program; Bare=$true },
  @{ Name='arguments'; Command='"C:\Windows\System32\OpenSSH\sshd.exe" -f other' },
  @{ Name='wrapper'; Command='cmd.exe /c "C:\Windows\System32\OpenSSH\sshd.exe"' },
  @{ Name='other directory'; Directory='C:\other\OpenSSH' },
  @{ Name='missing service'; MissingService=$true },
  @{ Name='multiple services'; MultipleServices=$true },
  @{ Name='stopped'; Service=@{ State='Stopped' } },
  @{ Name='wrong service user'; Service=@{ StartName='Other' } },
  @{ Name='no PID'; Service=@{ ProcessId=0 } },
  @{ Name='missing process'; MissingProcess=$true },
  @{ Name='wrong process'; Process=@{ ExecutablePath='C:\other\sshd.exe' } },
  @{ Name='unknown creation'; Process=@{ CreationDate=$null } },
  @{ Name='wrong process owner'; OtherOwner=$true },
  @{ Name='owner read failed'; OwnerFailure=$true },
  @{ Name='CIM failed'; ReadError=$true },
  @{ Name='ancestor reparse'; Reparse='C:\Windows' },
  @{ Name='directory reparse'; Reparse=$inbox },
  @{ Name='file reparse'; Reparse="$inbox\ssh-keygen.exe" },
  @{ Name='missing keygen'; MissingKeygen=$true },
  @{ Name='keygen is directory'; KeygenDirectory=$true },
  @{ Name='directory ACL'; UnsafeAcl=$inbox },
  @{ Name='sshd ACL'; UnsafeAcl="$inbox\sshd.exe" },
  @{ Name='keygen ACL'; UnsafeAcl="$inbox\ssh-keygen.exe" },
  @{ Name='unreadable ACL'; AclError=$true },
  @{ Name='unsigned sshd'; InvalidSignature="$inbox\sshd.exe" },
  @{ Name='unsigned keygen'; InvalidSignature="$inbox\ssh-keygen.exe" },
  @{ Name='wrong signer'; Signer='Other' },
  @{ Name='no signer'; MissingSigner=$true },
  @{ Name='service restart'; ChangeService='ProcessId'; ChangeValue=43 },
  @{ Name='service stopped'; ChangeService='State'; ChangeValue='Stopped' },
  @{ Name='service account changed'; ChangeService='StartName'; ChangeValue='Other' },
  @{ Name='command changed'; ChangeService='PathName'; ChangeValue='other' },
  @{ Name='process replaced'; ChangeProcess='CreationDate'; ChangeValue='2026-01-02T00:00:00Z' },
  @{ Name='process path changed'; ChangeProcess='ExecutablePath'; ChangeValue='C:\other\sshd.exe' },
  @{ Name='process became unavailable'; ChangeProcess='CreationDate'; ChangeValue=$null }
)
foreach ($case in $cases) {
  $script:case = $case
  $directory = if ($case.Directory) { $case.Directory } else { $inbox }
  $script:sshd = "$directory\sshd.exe"
  $script:serviceReads = 0; $script:processReads = 0
  $script:items = [Collections.Generic.List[string]]::new()
  $script:acls = [Collections.Generic.List[string]]::new()
  $script:signatures = [Collections.Generic.List[string]]::new()
  $result = $null; $failure = $null
  try { $result = Get-WindowsTestboxOpenSshInstallation } catch { $failure = $_.Exception.Message }
  if ($case.Accept) {
    Assert ($null -eq $failure -and $result.Sshd -eq $script:sshd -and $result.Keygen -eq "$directory\ssh-keygen.exe") $case.Name
    Assert ($result.PSObject.Properties.Name.Count -eq 2) 'pair only'
    Assert (($script:acls -join '|') -eq "$directory|$directory\sshd.exe|$directory\ssh-keygen.exe") 'exact ACL scope'
    Assert (($script:signatures -join '|') -eq "$directory\sshd.exe|$directory\ssh-keygen.exe") 'both signatures'
    Assert ($script:serviceReads -eq 2 -and $script:processReads -eq 2) 'stable identity reread'
  } else {
    Assert ($null -eq $result -and $failure -eq 'Cannot admit the native Windows OpenSSH installation; verify the provider service, Microsoft binaries, and installation permissions.') $case.Name
  }
  if ($case.Reparse) {
    Assert ($script:items[-1] -eq $case.Reparse -and $script:acls.Count -eq 0 -and $script:signatures.Count -eq 0) 'stop before following reparse'
  }
}
@{ installations=$cases.Count; descriptors=($aclCases.Count + 4) } | ConvertTo-Json -Compress
`,
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fixture,
        path.resolve("scripts/windows-testbox-openssh.ps1"),
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ installations: 40, descriptors: 25 });
  });
});
