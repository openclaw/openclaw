param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [ValidateSet("launch", "failure")][string]$Scenario
)

$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
# Load production functions without executing package installation or onboarding.
foreach ($definition in $ast.EndBlock.Statements) {
    if ($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
}

$shimDirectory = Join-Path $FixtureRoot 'handoff & ! %PATH% fixture'
$null = New-Item -ItemType Directory -Force -Path $shimDirectory
$script:shimPath = Join-Path $shimDirectory "openclaw.cmd"
$env:OPENCLAW_HANDOFF_MARKER = Join-Path $FixtureRoot "marker.txt"
$env:OPENCLAW_INSTALLER_SETUP_SHIM = "previous-value"
function Get-OpenClawCommandPath { return $script:shimPath }

if ($Scenario -eq "failure") {
    Set-Content -LiteralPath $script:shimPath -Value "@echo off" -Encoding ASCII
    function Get-TrustedWindowsCmdExe { return (Join-Path $FixtureRoot "missing-cmd.exe") }
    $script:launchError = $null
    $records = @(& {
        try { Invoke-InteractiveOpenClawCommand onboard } catch { $script:launchError = $_.Exception.Message }
    } 6>&1)
    # Avoid formatter line wrapping of long recovery commands on Windows PowerShell.
    $output = ($records | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if (-not $script:launchError) { throw "Missing interpreter unexpectedly started." }
    $recovery = "& '" + $script:shimPath.Replace("'", "''") + "' onboard"
    if (-not $output.Contains("Setup did not start. Run:") -or -not $output.Contains($recovery)) {
        throw "Launch failure omitted its manual recovery command: $output $script:launchError"
    }
} else {
    foreach ($exitCode in @(0, 23)) {
        $batch = "@echo off`r`n> `"%OPENCLAW_HANDOFF_MARKER%`" echo %~1`r`nexit /b $exitCode`r`n"
        [System.IO.File]::WriteAllText($script:shimPath, $batch, [System.Text.Encoding]::ASCII)
        $launchError = $null
        try { Invoke-InteractiveOpenClawCommand onboard } catch { $launchError = $_.Exception.Message }
        if ((Get-Content -LiteralPath $env:OPENCLAW_HANDOFF_MARKER -Raw).Trim() -ne "onboard") {
            throw "The batch shim did not receive the onboarding command."
        }
        Remove-Item -LiteralPath $env:OPENCLAW_HANDOFF_MARKER
        if ($exitCode -eq 0 -and $launchError) { throw $launchError }
        if ($exitCode -ne 0 -and $launchError -ne "openclaw onboard failed with exit code 23.") {
            throw "Child exit status was not preserved: $launchError"
        }
        if ($env:OPENCLAW_INSTALLER_SETUP_SHIM -ne "previous-value") {
            throw "The launch did not restore its temporary environment value."
        }
    }
}
if ($env:OPENCLAW_INSTALLER_SETUP_SHIM -ne "previous-value") {
    throw "The failed launch did not restore its temporary environment value."
}
Write-Output "handoff $Scenario passed"
