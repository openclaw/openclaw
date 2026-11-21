[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [ValidateSet('valid', 'missing-head', 'broken-gitfile', 'subdirectory')][string]$Scenario = 'valid'
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture root must be new' }
$seed = Join-Path $FixtureRoot 'seed'
$repo = Join-Path $FixtureRoot 'linked checkout'
$savedEnvironment = @{}
foreach ($name in @('TEMP', 'TMP', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Invoke-FixtureGit {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $($args -join ' ')" }
}
try {
    New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
    $env:TEMP = $env:TMP = $FixtureRoot
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = Join-Path $FixtureRoot 'no-global-gitconfig'
    Invoke-FixtureGit init -q --initial-branch=main --template= $seed
    Invoke-FixtureGit -C $seed config user.email test@example.invalid
    Invoke-FixtureGit -C $seed config user.name test
    Invoke-FixtureGit -C $seed config commit.gpgsign false
    Invoke-FixtureGit -C $seed config core.hooksPath (Join-Path $FixtureRoot 'no-hooks')
    Invoke-FixtureGit -C $seed commit --allow-empty -qm base
    Invoke-FixtureGit -C $seed worktree add -q --detach $repo HEAD
    $selected = (Invoke-FixtureGit -C $seed rev-parse HEAD).Trim()
    if ($Scenario -eq 'missing-head') {
        Invoke-FixtureGit -C $repo symbolic-ref HEAD refs/heads/missing
    } elseif ($Scenario -eq 'broken-gitfile') {
        # Git marks this file Hidden on Windows; open it without replacing its attributes.
        $bytes = [Text.Encoding]::UTF8.GetBytes('gitdir: ' + (Join-Path $FixtureRoot 'missing') + "`n")
        $stream = [IO.File]::Open((Join-Path $repo '.git'), [IO.FileMode]::Open, [IO.FileAccess]::Write)
        try {
            $stream.SetLength(0)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    } elseif ($Scenario -eq 'subdirectory') {
        $repo = Join-Path $seed 'subdirectory'
        New-Item -ItemType Directory -Path $repo | Out-Null
        [IO.File]::WriteAllText((Join-Path $repo 'local.txt'), 'keep')
    }
    $metadata = Join-Path $repo '.git'
    $before = if (Test-Path -LiteralPath $metadata) { (Get-FileHash -LiteralPath $metadata -Algorithm SHA256).Hash } else { $null }
    # Public DryRun loads the complete installer and exits Main before runtime,
    # package, service or Doctor operations. There is no private no-run selector.
    . $InstallerPath -DryRun -InstallMethod git -GitDir $repo -NoOnboard
    $script:BuildReached = $false
    function Ensure-Pnpm {
        param([string]$RepoDir, [string]$InstallDirectory)
        $script:BuildReached = $true
        throw 'FIXTURE_BUILD_BOUNDARY'
    }
    function New-TransactionalGitCheckout { throw 'UNEXPECTED_CLONE' }
    function Refresh-GatewayServiceIfLoaded { throw 'UNEXPECTED_SERVICE' }
    function Run-Doctor { throw 'UNEXPECTED_DOCTOR' }
    function Invoke-OpenClawCommand { throw 'UNEXPECTED_CLI' }
    $outcome = 'NO_BOUNDARY_EXCEPTION'
    try { $null = Install-OpenClawFromGit -RepoDir $repo -SkipUpdate } catch { $outcome = $_.Exception.Message }
    $expected = if ($Scenario -eq 'valid') { 'FIXTURE_BUILD_BOUNDARY' } elseif ($Scenario -eq 'subdirectory') { 'Git install dir exists but is not a git repo:' } else { 'Git checkout has no commit:' }
    $unchanged = (Invoke-FixtureGit -C $seed rev-parse HEAD).Trim() -eq $selected
    if ($before) {
        $unchanged = $unchanged -and (Get-FileHash -LiteralPath $metadata -Algorithm SHA256).Hash -eq $before
    } else {
        $unchanged = $unchanged -and [IO.File]::ReadAllText((Join-Path $repo 'local.txt')) -eq 'keep'
    }
    $passed = $outcome.StartsWith($expected, [StringComparison]::Ordinal) -and $unchanged -and ($script:BuildReached -eq ($Scenario -eq 'valid'))
    [pscustomobject]@{ scenario = $Scenario; passed = $passed; outcome = $outcome; expected = $expected; metadataAndPrimaryHeadPreserved = $unchanged; buildReached = $script:BuildReached } | ConvertTo-Json -Compress
    if (-not $passed) { exit 1 }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
    }
    if (Test-Path -LiteralPath $FixtureRoot) { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }
}
