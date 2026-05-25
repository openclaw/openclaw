#!/usr/bin/env pwsh

param(
    [ValidateSet("all", "backend", "ui")]
    [string]$Mode = "all",

    [switch]$Stop
)

$helperPath = Join-Path $PSScriptRoot "start-harvester-dashboard.ps1"
$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue

if (-not (Test-Path $helperPath)) {
    throw "Unable to find helper script: $helperPath"
}

if ($pwshCommand) {
    $arguments = @(
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $helperPath,
        "-Mode",
        $Mode
    )

    if ($Stop) {
        $arguments += "-Stop"
    }

    & $pwshCommand.Source @arguments
    exit $LASTEXITCODE
}

& $helperPath -Mode $Mode -Stop:$Stop
exit $LASTEXITCODE
