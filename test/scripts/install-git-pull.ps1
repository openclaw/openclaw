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
    $cases = [ordered]@{}
    $callerPreference = $ErrorActionPreference
    $successRepo = Join-Path $FixtureRoot 'success-checkout'
    Invoke-FixtureGit clone -q $upstream $successRepo
    $upstreamHead = Set-FixtureCommit -Root $upstream -Content 'next-upstream'
    Update-GitCheckoutBestEffort -RepoDir $successRepo
    $cases.successfulPull = (Invoke-FixtureGit -C $successRepo rev-parse HEAD).Trim() -eq $upstreamHead
    $cases.callerPreferenceRestored = $ErrorActionPreference -eq $callerPreference

    Invoke-FixtureGit -C $successRepo remote set-url origin (Join-Path $FixtureRoot 'missing-origin')
    Update-GitCheckoutBestEffort -RepoDir $successRepo
    $cases.unchangedFailure = (Invoke-FixtureGit -C $successRepo rev-parse HEAD).Trim() -eq $upstreamHead

    $successGitDir = (Invoke-FixtureGit -C $successRepo rev-parse --absolute-git-dir).Trim()
    $marker = Join-Path $successGitDir 'rebase-merge'
    New-Item -ItemType Directory -Path $marker | Out-Null
    try {
        $refused = $false
        try { Update-GitCheckoutBestEffort -RepoDir $successRepo } catch { $refused = $_.Exception.Message -like 'Could not record*' }
        $cases.preexistingRebase = $refused
    } finally { Remove-Item -LiteralPath $marker -Recurse -Force }
    $refused = $false
    try { Update-GitCheckoutBestEffort -RepoDir (Join-Path $FixtureRoot 'missing-checkout') } catch { $refused = $_.Exception.Message -like 'Could not record*' }
    $cases.unreadableState = $refused

    # Force only abort to fail; all discovery and the conflicting pull use real Git.
    $gitExecutable = (Get-Command git -CommandType Application).Source
    function git {
        if ($args -contains '--abort') { $global:LASTEXITCODE = 1; return }
        & $gitExecutable @args
        $global:LASTEXITCODE = $LASTEXITCODE
    }
    try {
        $refused = $false
        try { Update-GitCheckoutBestEffort -RepoDir $repo } catch { $refused = $_.Exception.Message -like '*could not be restored*' }
        $cases.abortFailure = $refused
    } finally {
        Remove-Item Function:git
        Invoke-FixtureGit -C $repo rebase --abort
    }

    # A readable post-failure state still must match both the exact HEAD and status.
    $originalStateReader = ${function:Get-GitCheckoutState}
    foreach ($changedField in @('Head', 'Status')) {
        $script:stateReads = 0
        function Get-GitCheckoutState {
            param([string]$RepoDir)
            $state = & $originalStateReader -RepoDir $RepoDir
            $script:stateReads++
            if ($script:stateReads -gt 1) { $state.$changedField = 'changed' }
            return $state
        }
        try {
            $refused = $false
            try { Update-GitCheckoutBestEffort -RepoDir $successRepo } catch { $refused = $_.Exception.Message -like '*could not be restored*' }
            $cases["mismatched$changedField"] = $refused
        } finally { Set-Item Function:Get-GitCheckoutState $originalStateReader }
    }

    $beforeInstallEnvironment = @{}
    foreach ($name in @('PATH', 'NODE_OPTIONS', 'PNPM_CONFIG_CHILD_CONCURRENCY', 'PNPM_CONFIG_NETWORK_CONCURRENCY', 'PNPM_CONFIG_WORKSPACE_CONCURRENCY', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'PNPM_CONFIG_SIDE_EFFECTS_CACHE', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'NPM_CONFIG_WORKSPACE_DIR', 'PNPM_CONFIG_LOCKFILE_DIR')) {
        $beforeInstallEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    [IO.File]::WriteAllText((Join-Path $repo 'docs.md'), 'dirty-fixture')
    $outcomeDirty = ''
    try { $null = Install-OpenClawFromGit -RepoDir $repo } catch { $outcomeDirty = $_.Exception.Message }
    $cases.dirtyBypass = $outcomeDirty -eq 'FIXTURE_BUILD_BOUNDARY' -and [IO.File]::ReadAllText((Join-Path $repo 'docs.md')) -eq 'dirty-fixture'
    $outcomeSkip = ''
    try { $null = Install-OpenClawFromGit -RepoDir $successRepo -SkipUpdate } catch { $outcomeSkip = $_.Exception.Message }
    $cases.skipUpdate = $outcomeSkip -eq 'FIXTURE_BUILD_BOUNDARY'
    $cases.callerEnvironmentRestored = $true
    foreach ($name in $beforeInstallEnvironment.Keys) {
        if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $beforeInstallEnvironment[$name]) { $cases.callerEnvironmentRestored = $false }
    }
    $passed = $passed -and -not ($cases.Values -contains $false)
    [pscustomobject]@{ passed = $passed; outcome = $outcome; aborted = $aborted; head = $head; expectedHead = $localHead; status = $porcelain; rebasing = $rebasing; cases = $cases } | ConvertTo-Json -Compress
    if (-not $passed) { exit 1 }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
    }
    if (Test-Path -LiteralPath $FixtureRoot) { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }
}
