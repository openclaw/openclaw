[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [ValidateSet('omitted', 'main', 'tag', 'missing', 'latest')][string]$Selector = 'omitted',
    [ValidateSet('fresh', 'existing')][string]$Checkout = 'fresh',
    [switch]$DisableGitUpdate,
    [switch]$AssertExplicitContract
)
$ErrorActionPreference = 'Stop'
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture root must be new' }
$script:FixtureGit = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$null = Get-Command node -CommandType Application -ErrorAction Stop
$installerHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$remote = Join-Path $FixtureRoot 'remote.git'
$seed = Join-Path $FixtureRoot 'seed'
$repo = Join-Path $FixtureRoot 'checkout with spaces'
$releaseTag = 'v2099.1.0'
$missingRef = 'fixture-ref-does-not-exist'
$requestedRef = switch ($Selector) {
    'omitted' { $null }
    'tag' { $releaseTag }
    'missing' { $missingRef }
    default { $Selector }
}
$savedEnvironment = @{}
$environmentNames = @(
    'TEMP', 'TMP', 'USERPROFILE', 'NODE_OPTIONS', 'NODE_PATH',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ALLOW_PROTOCOL',
    'GIT_TERMINAL_PROMPT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'
)
# Clear ambient Git overrides (including GIT_COMMON_DIR/GIT_EXEC_PATH), not
# merely global config, so every operation belongs to the disposable topology.
$environmentNames = @(@($environmentNames) + @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' } | ForEach-Object { $_.Name }) | Select-Object -Unique)
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Invoke-FixtureGit {
    # Absolute executable remains usable at the installer boundary even while
    # the Windows-style temporary pnpm PATH prefix is active on Linux.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    & $script:FixtureGit @args
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $($args -join ' ')" }
}
function Set-FixtureCommit {
    param([string]$Content)
    [IO.File]::WriteAllText((Join-Path $seed 'selector-marker.txt'), $Content)
    Invoke-FixtureGit -C $seed add selector-marker.txt
    Invoke-FixtureGit -C $seed commit -qm $Content -m 'Co-authored-by: MertBasar0 <100199793+MertBasar0@users.noreply.github.com>'
    return (Invoke-FixtureGit -C $seed rev-parse HEAD).Trim()
}
$ownsRoot = $false
try {
    New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
    $ownsRoot = $true
    foreach ($name in $environmentNames) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    $env:TEMP = $env:TMP = $env:USERPROFILE = $FixtureRoot
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = Join-Path $FixtureRoot 'gitconfig'
    $env:GIT_CONFIG_SYSTEM = Join-Path $FixtureRoot 'no-system-gitconfig'
    $env:GIT_ALLOW_PROTOCOL = 'file'
    $env:GIT_TERMINAL_PROMPT = '0'
    Invoke-FixtureGit config --global user.email fixture@example.invalid
    Invoke-FixtureGit config --global user.name 'Selector fixture'
    Invoke-FixtureGit config --global commit.gpgsign false
    Invoke-FixtureGit config --global tag.gpgsign false
    Invoke-FixtureGit config --global core.hooksPath (Join-Path $FixtureRoot 'no-hooks')
    Invoke-FixtureGit init --bare -q --initial-branch=main --template= $remote
    Invoke-FixtureGit init -q --initial-branch=main --template= $seed
    $releaseHead = Set-FixtureCommit -Content 'release'
    Invoke-FixtureGit -C $seed tag $releaseTag
    $mainHead = Set-FixtureCommit -Content 'main'
    Invoke-FixtureGit -C $seed checkout -qb working $releaseHead
    $workingInitialHead = Set-FixtureCommit -Content 'working-initial'
    Invoke-FixtureGit -C $seed remote add origin $remote
    Invoke-FixtureGit -C $seed push -q origin refs/heads/main refs/heads/working "refs/tags/$releaseTag"
    Invoke-FixtureGit --git-dir=$remote symbolic-ref HEAD refs/heads/main
    $initialHead = $null
    if ($Checkout -eq 'existing') {
        Invoke-FixtureGit clone -q $remote $repo
        Invoke-FixtureGit -C $repo checkout -q working
        $initialHead = (Invoke-FixtureGit -C $repo rev-parse HEAD).Trim()
        if ($initialHead -ne $workingInitialHead) { throw 'Existing checkout setup mismatch' }
    }
    $workingRemoteHead = Set-FixtureCommit -Content 'working-remote'
    Invoke-FixtureGit -C $seed push -q origin refs/heads/working
    if (@(@($releaseHead, $mainHead, $workingInitialHead, $workingRemoteHead) | Select-Object -Unique).Count -ne 4) {
        throw 'Fixture commits must be distinguishable'
    }
    # Transport redirect only: production clone/pull/ref commands stay intact.
    # No network Git protocol is allowed, even if the redirect stops matching.
    $remoteTransportPath = $remote.Replace('\', '/')
    Invoke-FixtureGit config --global "url.$remoteTransportPath.insteadOf" 'https://github.com/openclaw/openclaw.git'

    # Same complete-script loader as install-git-worktree.ps1/install-git-pull.ps1.
    # A splat truly omits Tag for the omitted control; no function extraction.
    $installerArguments = @{
        DryRun = $true; InstallMethod = 'git'; GitDir = $repo
        NoOnboard = $true; NoGitUpdate = [bool]$DisableGitUpdate
    }
    if ($Selector -ne 'omitted') { $installerArguments.Tag = $requestedRef }
    . $InstallerPath @installerArguments
    $script:BoundaryHead = $null
    $script:BoundaryMarker = $null
    $script:BoundaryReached = $false
    $script:UnexpectedEffects = [Collections.Generic.List[string]]::new()
    function Stop-FixtureEffect {
        param([string]$Name)
        $script:UnexpectedEffects.Add($Name)
        throw "UNEXPECTED_EFFECT:$Name"
    }
    # Prerequisite/side-effect boundaries only; never replace Main, the Git
    # installer, clone, pull, checkout validation, or selector decisions.
    function Check-ExistingOpenClaw { return $false }
    function Check-Node { return $true }
    function Install-Node { Stop-FixtureEffect 'Install-Node' }
    function Install-PortableGit { Stop-FixtureEffect 'Install-PortableGit' }
    function Get-NpmCommandPath { return $null }
    function Invoke-NpmCommand { Stop-FixtureEffect 'Invoke-NpmCommand' }
    function Add-ToUserPath { Stop-FixtureEffect 'Add-ToUserPath' }
    function Publish-TextFileAtomically { Stop-FixtureEffect 'Publish-TextFileAtomically' }
    function Remove-PreviousNpmOwner { Stop-FixtureEffect 'Remove-PreviousNpmOwner' }
    function Ensure-OpenClawOnPath { Stop-FixtureEffect 'Ensure-OpenClawOnPath' }
    function Refresh-GatewayServiceIfLoaded { Stop-FixtureEffect 'Refresh-GatewayServiceIfLoaded' }
    function Run-Doctor { Stop-FixtureEffect 'Run-Doctor' }
    function Invoke-OpenClawCommand { Stop-FixtureEffect 'Invoke-OpenClawCommand' }
    function Invoke-InteractiveOpenClawCommand { Stop-FixtureEffect 'Invoke-InteractiveOpenClawCommand' }
    function Ensure-Pnpm {
        param([string]$RepoDir, [string]$InstallDirectory)
        $script:BoundaryHead = (Invoke-FixtureGit -C $RepoDir rev-parse HEAD).Trim()
        $script:BoundaryMarker = [IO.File]::ReadAllText((Join-Path $RepoDir 'selector-marker.txt'))
        $script:BoundaryReached = $true
        throw 'FIXTURE_BUILD_BOUNDARY'
    }
    # Re-enter the real dispatcher with parameters bound by the public loader.
    # This is deliberately stronger than directly invoking the Git helper.
    $DryRun = $false
    $outcome = 'RETURNED_WITHOUT_BOUNDARY'
    try { $null = Main } catch { $outcome = $_.Exception.Message }
    if ($script:UnexpectedEffects.Count -gt 0) {
        throw "Fixture isolation guard fired: $($script:UnexpectedEffects -join ', ')"
    }
    $actualHeadAfterAttempt = $null
    if (Test-Path -LiteralPath (Join-Path $repo '.git')) {
        $actualHeadAfterAttempt = (Invoke-FixtureGit -C $repo rev-parse HEAD).Trim()
    }
    $expectedHead = switch ($Selector) {
        'main' { $mainHead }
        'tag' { $releaseHead }
        default { $null }
    }
    # NoGitUpdate combinations and omitted/latest remain observation-only until
    # the owner selects their contract. Do not turn a proposed default into a test.
    $contractEvaluated = (-not $DisableGitUpdate) -and ($Selector -in @('main', 'tag', 'missing'))
    $contractSatisfied = $null
    if ($contractEvaluated) {
        if ($Selector -eq 'missing') {
            $contractSatisfied = (-not $script:BoundaryReached) -and $outcome.Contains($missingRef)
        } else {
            $contractSatisfied = $outcome -eq 'FIXTURE_BUILD_BOUNDARY' -and $script:BoundaryHead -eq $expectedHead
        }
    }
    $proof = [ordered]@{
        status = 'executed'; installerSha256 = $installerHash
        powershell = $PSVersionTable.PSVersion.ToString(); checkout = $Checkout
        selector = $Selector; requestedSelector = $requestedRef
        selectorWasExplicit = ($Selector -ne 'omitted'); effectiveTag = $Tag
        noGitUpdate = [bool]$DisableGitUpdate; initialHead = $initialHead
        fixtureRefs = @{ main = $mainHead; release = $releaseHead; workingInitial = $workingInitialHead; workingRemote = $workingRemoteHead }
        actualHeadAtBuildBoundary = $script:BoundaryHead
        markerAtBuildBoundary = $script:BoundaryMarker
        actualHeadAfterAttempt = $actualHeadAfterAttempt
        buildBoundaryReached = $script:BoundaryReached
        packageInstallationAttempted = $false; buildAttempted = $false
        expectedHeadForExplicitRef = $expectedHead
        contractEvaluated = $contractEvaluated; contractSatisfied = $contractSatisfied
        outcome = $outcome; installerExitCode = $script:InstallExitCode
        unexpectedEffects = $script:UnexpectedEffects.ToArray()
    }
    Write-Output ('RESULT:' + ($proof | ConvertTo-Json -Depth 6 -Compress))
    if ($AssertExplicitContract -and $contractEvaluated -and -not $contractSatisfied) { exit 1 }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
    }
    if ($ownsRoot -and (Test-Path -LiteralPath $FixtureRoot)) {
        Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
    }
}
