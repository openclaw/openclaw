import { windowsPackageInstallScript } from "../../scripts/e2e/parallels/powershell.ts";

export function windowsPackageInstallProbe(exitCode: number, alreadyOnPath: boolean): string {
  return `
class Environment {
  static [string] $UserPath
  static [string] GetEnvironmentVariable([string] $name, [string] $scope) {
    if ($name -ne 'Path' -or $scope -ne 'User') { throw 'unexpected environment read' }
    return [Environment]::UserPath
  }
  static [void] SetEnvironmentVariable([string] $name, [string] $value, [string] $scope) {
    if ($name -ne 'Path' -or $scope -ne 'User') { throw 'unexpected environment write' }
    [Environment]::UserPath = $value
  }
}
$prefix = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $prefix | Out-Null
New-Item -ItemType File -Path (Join-Path $prefix 'openclaw.cmd') | Out-Null
$previousPath = 'C:\\fixture\\existing'${alreadyOnPath ? ' + ";" + $prefix.ToUpperInvariant()' : ""}
[Environment]::UserPath = $previousPath
function curl.exe { $global:LASTEXITCODE = 0 }
function npm.cmd {
  if ($args[0] -eq 'prefix') { Write-Output $prefix; $global:LASTEXITCODE = 0; return }
  & $env:ComSpec /d /s /c 'echo npm notice 1>&2 & exit /b ${exitCode}'
}
function Invoke-OpenClaw { Write-Output 'OpenClaw fixture'; $global:LASTEXITCODE = 0 }
try {
  & {
${windowsPackageInstallScript("https://example.test/openclaw.tgz", "openclaw-fixture.tgz")}
  } *>&1 | Out-String | Write-Output
  $expectedPath = ${alreadyOnPath ? "$previousPath" : '"$previousPath;$prefix"'}
  if ([Environment]::UserPath -cne $expectedPath) { throw 'incorrect persistent CLI PATH handoff' }
  exit 0
} catch {
  Write-Output $_
  exit 1
} finally {
  Remove-Item -LiteralPath $prefix -Recurse -Force
}`;
}
