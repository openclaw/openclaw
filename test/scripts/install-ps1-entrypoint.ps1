param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$env:OPENCLAW_DRY_RUN = '1'
$env:OPENCLAW_NO_ONBOARD = '1'
$env:OPENCLAW_INSTALL_METHOD = 'npm'

# Evaluate the complete script through the documented pipeline, without parameter binding.
$output = & { Get-Content -LiteralPath $InstallerPath -Raw | Invoke-Expression } 6>&1 | Out-String
foreach ($expected in @('[OK] Windows detected', '[OK] Dry run', '[OK] Install method: npm', '[OK] Onboard: skipped')) {
    if (-not $output.Contains($expected)) { throw "Piped installer missed '$expected':`n$output" }
}
Write-Output $output

$installer = [scriptblock]::Create((Get-Content -LiteralPath $InstallerPath -Raw))
$prefix = Join-Path ([System.IO.Path]::GetTempPath()) 'openclaw-node-dry-run'
$output = & $installer -NodeOnly -NodePrefix $prefix -NodeVersion '26.12.1' -DryRun 6>&1 | Out-String
if (-not $output.Contains('[OK] Would install private Node.js')) { throw "Exact Node version rejected:`n$output" }

try {
    & $installer -NodeOnly -NodePrefix $prefix -NodeVersion '26.x' -DryRun
    throw 'Malformed Node version was accepted'
} catch {
    if ($_.FullyQualifiedErrorId -notmatch '^ParameterArgumentValidationError') { throw }
}
Write-Output 'Piped installer and optional Node version validation passed'
