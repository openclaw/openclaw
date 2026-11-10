[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture root must be new' }
$upstream = Join-Path $FixtureRoot 'upstream'
$repo = Join-Path $FixtureRoot 'checkout'
$savedEnvironment = @{}
foreach ($name in @('TEMP', 'TMP', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Invoke-FixtureGit {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $($args -join ' ')" }
}
function Set-FixtureCommit {
    param([string]$Root, [string]$Content)
    [IO.File]::WriteAllText((Join-Path $Root 'docs.md'), $Content)
    Invoke-FixtureGit -C $Root add docs.md
    Invoke-FixtureGit -C $Root commit -qm $Content
    return (Invoke-FixtureGit -C $Root rev-parse HEAD).Trim()
}
try {
    New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
    $env:TEMP = $env:TMP = $FixtureRoot
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = Join-Path $FixtureRoot 'gitconfig'
    Invoke-FixtureGit config --global user.email test@example.invalid
    Invoke-FixtureGit config --global user.name test
    Invoke-FixtureGit config --global commit.gpgsign false
    Invoke-FixtureGit config --global core.hooksPath (Join-Path $FixtureRoot 'no-hooks')
    Invoke-FixtureGit init -q --initial-branch=main --template= $upstream
    $null = Set-FixtureCommit -Root $upstream -Content 'base'
    Invoke-FixtureGit clone -q $upstream $repo
    $null = Set-FixtureCommit -Root $upstream -Content 'upstream'
    # A local commit touching the same file makes pull --rebase stop on a conflict.
    $localHead = Set-FixtureCommit -Root $repo -Content 'local'

    # Public DryRun loads the complete installer and exits Main before runtime work.
    . $InstallerPath -DryRun -InstallMethod git -GitDir $repo -NoOnboard
    function Ensure-Pnpm { throw 'FIXTURE_BUILD_BOUNDARY' }
    function New-TransactionalGitCheckout { throw 'UNEXPECTED_CLONE' }
    $outcome = 'NO_BOUNDARY_EXCEPTION'
    try { $null = Install-OpenClawFromGit -RepoDir $repo } catch { $outcome = $_.Exception.Message }

    $gitDir = (Invoke-FixtureGit -C $repo rev-parse --absolute-git-dir).Trim()
    $head = (Invoke-FixtureGit -C $repo rev-parse HEAD).Trim()
    $porcelain = (Invoke-FixtureGit -C $repo status --porcelain --untracked-files=all | Out-String).Trim()
    $rebasing = (Test-Path -LiteralPath (Join-Path $gitDir 'rebase-merge')) -or (Test-Path -LiteralPath (Join-Path $gitDir 'rebase-apply'))
    # The reflog proves the pull reached the conflicted rebase and the installer aborted it.
    $aborted = [bool](@(Invoke-FixtureGit -C $repo reflog -n 5 --format=%gs) -match '^rebase \(abort\)')
    $passed = $outcome -eq 'FIXTURE_BUILD_BOUNDARY' -and $aborted -and $head -eq $localHead -and -not $porcelain -and -not $rebasing
    [pscustomobject]@{ passed = $passed; outcome = $outcome; aborted = $aborted; head = $head; expectedHead = $localHead; status = $porcelain; rebasing = $rebasing } | ConvertTo-Json -Compress
    if (-not $passed) { exit 1 }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
    }
    if (Test-Path -LiteralPath $FixtureRoot) { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }
}
