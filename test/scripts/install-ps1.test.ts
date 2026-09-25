import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractFunctionBody } from "./install-ps1.test-support.js";

const SCRIPT_PATH = "scripts/install.ps1";

describe("install.ps1 source contracts", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  it("does not exit directly from inside Main", () => {
    const mainBody = extractFunctionBody(source, "Main");
    expect(mainBody).not.toMatch(/\bexit\b/i);
    expect(mainBody).toContain("Fail-Install");
  });

  it("keeps failure termination in the top-level completion handler", () => {
    const completeInstallBody = extractFunctionBody(source, "Complete-Install");
    expect(completeInstallBody).toMatch(/\$PSCommandPath/);
    expect(completeInstallBody).toMatch(/\bexit \$script:InstallExitCode\b/);
    expect(completeInstallBody).toMatch(/\bthrow "OpenClaw installation failed with exit code/);
    expect(completeInstallBody).toContain("$script:InstallExitCode -eq 0");
    expect(source).toContain("$null = Main");
    expect(source).toMatch(/\$null = Main\s+Complete-Install\s*$/);
  });

  it("checks the full supported Node version range", () => {
    const versionBody = extractFunctionBody(source, "Test-NodeVersionSupported");
    const sqliteBody = extractFunctionBody(source, "Test-NodeSqliteSupported");
    const checkNodeBody = extractFunctionBody(source, "Check-Node");
    expect(versionBody).toContain("$major -eq 24");
    expect(versionBody).toContain("$minor -ge 16");
    expect(versionBody).toContain("$major -eq 26");
    expect(versionBody).toContain("$minor -ge 1");
    expect(versionBody).toContain("$major -gt 26");
    expect(sqliteBody).toContain("$minor -eq 51 -and $patch -ge 3");
    expect(checkNodeBody).toContain("Test-NodeVersionSupported -Version $nodeVersion");
    expect(checkNodeBody).toContain("Get-Command node -CommandType Application");
    expect(checkNodeBody).toContain("SELECT sqlite_version() AS version");
    expect(checkNodeBody).toContain("$sqliteProbe | & $nodePath -");
    expect(checkNodeBody).not.toContain("& $nodePath -e");
    expect(checkNodeBody).toContain("Test-NodeSqliteSupported -Version $sqliteVersion");
    expect(checkNodeBody).toContain(
      "SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x is required",
    );
    expect(source).toContain("Please install Node.js 26 manually:");
  });

  it("discovers a winget Node install before the machine PATH refreshes", () => {
    const installNodeBody = extractFunctionBody(source, "Install-Node");
    const packageManagerBody = extractFunctionBody(source, "Invoke-NodePackageManagerInstall");
    const addInstalledNodeBody = extractFunctionBody(source, "Add-InstalledNodeToProcessPath");
    expect(installNodeBody).toContain("-DiscoverProgramFilesNode");
    expect(packageManagerBody).toContain("Add-InstalledNodeToProcessPath | Out-Null");
    expect(addInstalledNodeBody).toContain("$env:ProgramW6432");
    expect(addInstalledNodeBody).toContain("$env:ProgramFiles");
    expect(addInstalledNodeBody).toContain('Join-Path $nodeDir "node.exe"');
    expect(addInstalledNodeBody).toContain("Add-ToProcessPath $nodeDir");
  });

  it("runs npm install through the resolved command with quiet CI defaults", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    expect(npmInstallBody).toContain(
      "$npmOutput = Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments",
    );
    expect(npmInstallBody).toContain("$npmDebugLogRoots = @(Get-NpmDebugLogRootCandidates)");
    expect(npmInstallBody).toContain('$npmInstallArguments = @("install", "-g")');
    expect(npmInstallBody).toContain('Write-Host "[!] npm install failed; retrying once"');
    expect(
      npmInstallBody.match(
        /Invoke-NpmCommand -CommandPath \$npmCommand -WorkingDirectory \$npmCwd -Arguments \$npmInstallArguments/g,
      ),
    ).toHaveLength(2);
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_LOGLEVEL = "error"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_UPDATE_NOTIFIER = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_FUND = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_AUDIT = "false"');
    expect(npmInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(npmInstallBody).toContain('$freshnessArgs = @("--min-release-age=0")');
    expect(npmInstallBody).toContain("Remove-Item Env:NPM_CONFIG_BEFORE");
    expect(npmInstallBody).toContain("Remove-Item Env:NPM_CONFIG_MIN_RELEASE_AGE");
    expect(npmInstallBody).toContain("$env:NPM_CONFIG_LOGLEVEL = $prevLogLevel");
    expect(npmInstallBody).toContain("$env:NPM_CONFIG_BEFORE = $prevBefore");
    expect(npmInstallBody).toContain(
      "Write-NpmInstallFailureDetails -Output $npmOutput -CacheRoots $npmDebugLogRoots",
    );
    expect(source).toContain("function Get-LatestNpmDebugLogPath {");
    expect(source).toContain("Get-Content -LiteralPath $latestLog -Tail 120");
  });

  it("does not force npm or pnpm lifecycle scripts through cmd.exe", () => {
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");

    expect(ensurePnpmBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(npmInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(gitInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
  });

  it("rejects a git checkout without a commit before updating it", () => {
    const guardBody = extractFunctionBody(source, "Assert-GitCheckoutHasCommit");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");

    expect(guardBody).toContain('"--git-dir=$gitDir"');
    expect(guardBody).toContain('"--work-tree=$RepoDir"');
    expect(guardBody).toContain('rev-parse --verify --quiet "HEAD^{commit}"');
    expect(guardBody).toContain("Git checkout has no commit");
    expect(guardBody).not.toContain("Remove-Item");
    expect(guardBody).not.toContain("Move-Item");
    expect(gitInstallBody).toContain("Assert-GitCheckoutHasCommit -RepoDir $RepoDir");
  });

  it("runs Windows command shims from a Windows-local cwd", () => {
    const commandSafeBody = extractFunctionBody(source, "Invoke-CommandFromWindowsSafeDirectory");
    const npmCommandBody = extractFunctionBody(source, "Invoke-NpmCommand");
    const openClawPathBody = extractFunctionBody(source, "Ensure-OpenClawOnPath");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const mainBody = extractFunctionBody(source, "Main");

    expect(commandSafeBody).toContain("Get-WindowsCommandSafeDirectory");
    expect(commandSafeBody).toContain("$WorkingDirectory");
    expect(commandSafeBody).toContain("Push-Location -LiteralPath $safeDir");
    expect(commandSafeBody).toContain("& $CommandPath @Arguments");
    expect(commandSafeBody).toContain("Pop-Location");
    expect(npmCommandBody).toContain("Invoke-CommandFromWindowsSafeDirectory");
    expect(openClawPathBody).toContain('Invoke-NpmCommand -Arguments @("config", "get", "prefix")');
    expect(ensurePnpmBody).toContain(
      '@("enable", "--install-directory", $InstallDirectory, "pnpm")',
    );
    expect(ensurePnpmBody).toContain(
      "Invoke-NpmCommand -CommandPath $npmCommand -Arguments $installArgs",
    );
    expect(mainBody).toContain("Remove-PreviousNpmOwner");
    expect(mainBody).toContain("Remove-PreviousGitWrapper");
    expect(mainBody).toContain("Start-NpmShimBackup");
    expect(mainBody).toContain("Restore-NpmShimBackup");
    expect(mainBody).toContain("Complete-NpmShimBackup");
    expect(mainBody).toContain(
      'Invoke-NpmCommand -Arguments @("list", "-g", "--depth", "0", "--json")',
    );
  });

  it("selects one canonical temp root for installer and child process paths", () => {
    const resolveBody = extractFunctionBody(source, "Resolve-InstallerTempDirectory");
    const initializeBody = extractFunctionBody(source, "Initialize-InstallerTempDirectory");
    const portableNodeBody = extractFunctionBody(source, "Install-PortableNode");
    const portableGitBody = extractFunctionBody(source, "Install-PortableGit");
    const commandSafeBody = extractFunctionBody(source, "Get-WindowsCommandSafeDirectory");

    expect(resolveBody).toContain("Get-Item -LiteralPath $pathToResolve -ErrorAction Stop");
    expect(resolveBody).toContain(".FullName");
    expect(resolveBody).toContain("FSO Folder.Path echoes 8.3 aliases");
    expect(resolveBody).not.toContain("Scripting.FileSystemObject");
    expect(resolveBody).toContain("$resolvedCandidate.Substring(8)");
    expect(resolveBody).toContain("$resolvedCandidate.Substring(4)");
    expect(resolveBody).toContain("Test-Path -LiteralPath $resolvedCandidate -PathType Container");
    expect(initializeBody).toContain("$script:InstallerTempDirectory = $tempDirectory");
    expect(initializeBody).toContain("$env:TEMP = $tempDirectory");
    expect(initializeBody).toContain("$env:TMP = $tempDirectory");
    expect(portableNodeBody).toContain("Join-Path $script:InstallerTempDirectory");
    expect(portableGitBody).toContain("Join-Path $script:InstallerTempDirectory");
    expect(commandSafeBody).toContain("return $script:InstallerTempDirectory");
    expect(source.match(/^Initialize-InstallerTempDirectory$/gm)).toHaveLength(1);
    expect(source).not.toContain("Get-InstallerTempDirectory");
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const sourceTargetBody = extractFunctionBody(source, "Test-OpenClawSourcePackageInstallSpec");
    expect(sourceTargetBody).toContain('$normalizedTag -eq "main"');
    expect(sourceTargetBody).toContain("^github:openclaw/openclaw");
    expect(npmInstallBody).toContain("Test-OpenClawSourcePackageInstallSpec -RequestedTag $Tag");
    expect(npmInstallBody).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(npmInstallBody).toContain("-InstallMethod git -Tag main");
  });

  it("does not read project npmrc when choosing global install freshness args", () => {
    const rawKeyBody = extractFunctionBody(source, "Test-NpmConfigRawKey");
    expect(rawKeyBody).not.toContain("Get-Location");
    expect(rawKeyBody).not.toContain('Join-Path (Get-Location) ".npmrc"');
  });

  it("preserves the min-release-age probe status before raw npmrc detection", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const probeStatusCapture = npmInstallBody.indexOf("$minReleaseAgeStatus = $LASTEXITCODE");
    const rawKeyProbe = npmInstallBody.indexOf("Test-NpmConfigRawKey -Key");
    expect(probeStatusCapture).toBeGreaterThan(-1);
    expect(rawKeyProbe).toBeGreaterThan(-1);
    expect(probeStatusCapture).toBeLessThan(rawKeyProbe);
    expect(npmInstallBody).toContain(
      "} elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge",
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "min-release-age", "--global")',
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "before", "--global")',
    );
  });

  it("preserves caller-relative local tarball install specs before safe-cwd npm calls", () => {
    const resolveSpecBody = extractFunctionBody(source, "Resolve-NpmOpenClawInstallSpec");
    const localSpecBody = extractFunctionBody(source, "Resolve-LocalNpmPackageInstallSpec");
    const localPathBody = extractFunctionBody(source, "Resolve-LocalNpmPackagePath");

    expect(resolveSpecBody).toContain(
      "Resolve-LocalNpmPackageInstallSpec -InstallSpec $trimmedTag",
    );
    expect(localSpecBody).toContain("$InstallSpec -match '^file:(?<path>.+)$'");
    expect(localSpecBody).toContain("Resolve-LocalNpmPackagePath -PackagePath $filePath");
    expect(localSpecBody).toContain(").AbsoluteUri");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '^\\.\\.?[\\\\/]'");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '\\.tgz$'");
    expect(localPathBody).toContain("Resolve-Path -LiteralPath $PackagePath");
    expect(localPathBody).toContain("[System.IO.Path]::GetFullPath($PackagePath)");
  });

  it("falls back to a user-local portable Node.js bootstrap when package managers are absent", () => {
    const installNodeBody = extractFunctionBody(source, "Install-Node");
    const portableNodeBody = extractFunctionBody(source, "Install-PortableNode");
    const portableNodeRootBody = extractFunctionBody(source, "Get-PortableNodeRoot");
    const portableNodePathBody = extractFunctionBody(source, "Ensure-PortableNodeOnUserPath");
    const userPathBody = extractFunctionBody(source, "Add-ToUserPath");
    const depsRootBody = extractFunctionBody(source, "Get-OpenClawDepsRoot");
    const resolveNodeBody = extractFunctionBody(source, "Resolve-PortableNodeDownload");
    const expandNodeBody = extractFunctionBody(source, "Expand-PortableNodeArchive");

    expect(installNodeBody).toContain("Install-PortableNode");
    expect(installNodeBody).toContain("Portable Node.js bootstrap failed");
    expect(installNodeBody).toContain("Error: Could not install Node.js automatically.");
    expect(depsRootBody).toContain("OpenClaw\\deps");
    expect(portableNodeRootBody).toContain("portable-node");
    expect(portableNodeBody).toContain("Ensure-PortableNodeOnUserPath");
    expect(portableNodeBody).toContain("Bootstrapping user-local portable Node.js");
    expect(portableNodeBody).toContain(
      "Expand-PortableNodeArchive -ZipPath $tmpZip -DestinationPath $portableRoot",
    );
    expect(portableNodeBody).not.toContain("Copy-Item");
    expect(portableNodeBody).not.toContain('Join-Path $nodeDir.FullName "*"');
    expect(portableNodePathBody).toContain("Add-ToUserPath $nodeDir");
    expect(userPathBody).toContain(
      '[Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")',
    );
    expect(portableNodeBody).toContain(
      "Save-InstallerDownload -Uri $download.Url -OutFile $tmpZip",
    );
    expect(portableNodeBody).toContain("Expand-PortableNodeArchive");
    expect(portableNodeBody).not.toContain("Expand-Archive");
    expect(portableNodeBody).not.toContain("New-Item -ItemType Directory -Force -Path $tmpExtract");
    expect(expandNodeBody).toContain("Get-Command tar");
    expect(expandNodeBody).toContain(
      "Copy-Item -LiteralPath $nodeDir.FullName -Destination $DestinationPath -Recurse -Force",
    );
    expect(expandNodeBody).toContain("System.IO.Compression.ZipFile");
    expect(resolveNodeBody).toContain("https://nodejs.org/dist/index.json");
    expect(resolveNodeBody).toContain(
      'Get-WebRequestTimeoutParameters -CommandName "Invoke-RestMethod"',
    );
    expect(resolveNodeBody).toContain("@requestTimeouts");
    expect(resolveNodeBody).toContain("win-$architecture-zip");
    expect(resolveNodeBody).toContain("node-$($release.version)-win-$architecture.zip");
  });

  it("persists user-local portable Git for future git-backed updates", () => {
    const portableGitRootBody = extractFunctionBody(source, "Get-PortableGitRoot");
    const portableGitBody = extractFunctionBody(source, "Install-PortableGit");
    const portableArchitectureBody = extractFunctionBody(source, "Get-WindowsPortableArchitecture");
    const portableGitDownloadBody = extractFunctionBody(source, "Resolve-PortableGitDownload");
    const portableGitPathEntriesBody = extractFunctionBody(source, "Get-PortableGitPathEntries");
    const portableGitPathBody = extractFunctionBody(source, "Ensure-PortableGitOnUserPath");
    const usePortableGitBody = extractFunctionBody(source, "Use-PortableGitIfPresent");
    const ensureGitBody = extractFunctionBody(source, "Ensure-Git");

    expect(portableGitRootBody).toContain("Get-OpenClawDepsRoot");
    expect(portableGitPathEntriesBody).toContain("mingw64\\bin");
    expect(portableGitPathEntriesBody).toContain("usr\\bin");
    expect(portableGitPathEntriesBody).toContain("Split-Path -Parent $gitExe");
    expect(usePortableGitBody).toContain("foreach ($pathEntry in (Get-PortableGitPathEntries))");
    expect(portableGitBody).toContain("Ensure-PortableGitOnUserPath");
    expect(ensureGitBody).toContain("Ensure-PortableGitOnUserPath");
    expect(portableGitPathBody).toContain("Add-ToUserPath $pathEntry");
    expect(portableGitPathBody).toContain("git-backed updates");
    expect(portableArchitectureBody).toContain("Win32_Processor");
    expect(portableArchitectureBody).toContain("Architecture -eq 12");
    expect(portableArchitectureBody).toContain("Win32_ComputerSystem");
    expect(portableArchitectureBody).toContain("PROCESSOR_ARCHITEW6432");
    expect(portableArchitectureBody).toContain("PROCESSOR_ARCHITECTURE");
    expect(portableGitDownloadBody).toContain("Get-WindowsPortableArchitecture");
    expect(portableGitDownloadBody).toContain(
      'Get-WebRequestTimeoutParameters -CommandName "Invoke-RestMethod"',
    );
    expect(portableGitDownloadBody).toContain("@requestTimeouts");
    expect(portableGitBody).toContain("Save-InstallerDownload -Uri $download.Url -OutFile $tmpZip");
    expect(portableGitDownloadBody).toContain("'^MinGit-.*-arm64\\.zip$'");
    expect(portableGitDownloadBody).toContain("'^MinGit-.*-64-bit\\.zip$'");
    expect(portableGitBody).toContain(
      '$tempName = "openclaw-portable-git-" + [guid]::NewGuid().ToString("N")',
    );
    expect(portableGitBody).toContain(
      'Join-Path $script:InstallerTempDirectory ($tempName + ".zip")',
    );
    expect(portableGitBody).toContain("Join-Path $script:InstallerTempDirectory $tempName");
    expect(portableGitBody).toContain(
      "New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null",
    );
  });

  it("preserves git install budgets and guards with scoped pnpm selection", () => {
    const pnpmVersionBody = extractFunctionBody(source, "Get-RepoPnpmVersion");
    const pnpmVersionMatchBody = extractFunctionBody(source, "Test-PnpmCommandMatchesVersion");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const gitFilterSupportBody = extractFunctionBody(source, "Test-GitFilterSupport");
    const transactionalCloneBody = extractFunctionBody(source, "New-TransactionalGitCheckout");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const nodeOptionsBody = extractFunctionBody(source, "Resolve-NodeOptionsWithMinOldSpace");
    const mainBody = extractFunctionBody(source, "Main");

    expect(pnpmVersionBody).toContain("package.json");
    expect(pnpmVersionBody).toContain(
      "$packageJson.packageManager -match '^pnpm@(?<version>[^+]+)'",
    );
    expect(pnpmVersionMatchBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(pnpmVersionMatchBody).toContain("$currentVersion.Trim() -eq $PnpmVersion");
    expect(pnpmVersionMatchBody).toContain("} catch {");
    expect(pnpmVersionMatchBody).toContain("return $false");
    expect(ensurePnpmBody).toContain("Get-RepoPnpmVersion -RepoDir $RepoDir");
    expect(ensurePnpmBody).toContain("$pnpmSpec");
    expect(ensurePnpmBody).toContain(
      "Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir -PnpmCommand $pnpmCommand",
    );
    expect(ensurePnpmBody).toContain(
      '@("enable", "--install-directory", $InstallDirectory, "pnpm")',
    );
    expect(ensurePnpmBody).toContain(
      "Invoke-NpmCommand -CommandPath $npmCommand -Arguments $installArgs",
    );
    expect(gitFilterSupportBody).toContain("git clone -h");
    expect(gitFilterSupportBody).toContain("filter");
    expect(transactionalCloneBody).toContain('$cloneArgs += "--filter=blob:none"');
    expect(transactionalCloneBody).toContain("& git @cloneArgs");
    expect(gitInstallBody.indexOf("New-TransactionalGitCheckout")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(gitInstallBody.indexOf("git -C $RepoDir pull --rebase")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(mainBody).toContain("$gitInstallResults = @(Install-OpenClawFromGit");
    expect(mainBody).toContain("Test-BooleanSuccessResult -Results $gitInstallResults");
    expect(mainBody).toContain("$npmInstallResults = @(Install-OpenClaw)");
    expect(mainBody).toContain("Test-BooleanSuccessResult -Results $npmInstallResults");
    expect(gitInstallBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(gitInstallBody).toContain('$sourceInstallArgs = @("install")');
    expect(gitInstallBody).toContain("Test-ShouldPreferOfflinePnpmInstall -ProjectDir $RepoDir");
    expect(gitInstallBody).toContain('"--config.node-linker=hoisted"');
    expect(gitInstallBody).toContain('"--config.enable-pre-post-scripts=true"');
    expect(gitInstallBody).toContain('"--config.side-effects-cache=false"');
    expect(gitInstallBody).toContain('"--no-frozen-lockfile"');
    expect(gitInstallBody).not.toContain('"--frozen-lockfile"');
    expect(gitInstallBody).not.toContain('"--filter"');
    expect(gitInstallBody).not.toContain('"--ignore-scripts=true"');
    expect(gitInstallBody).toContain(
      '"--config.child-concurrency=$env:PNPM_CONFIG_CHILD_CONCURRENCY"',
    );
    expect(gitInstallBody).toContain(
      '"--config.network-concurrency=$env:PNPM_CONFIG_NETWORK_CONCURRENCY"',
    );
    expect(gitInstallBody).toContain(
      '"--config.workspace-concurrency=$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY"',
    );
    expect(gitInstallBody).toContain("& $pnpmCommand @sourceInstallArgs");
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_CHILD_CONCURRENCY = "1"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_NETWORK_CONCURRENCY = "4"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = "1"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_SIDE_EFFECTS_CACHE = "false"');
    expect(gitInstallBody).toContain("$installSucceeded = ($LASTEXITCODE -eq 0)");
    expect(gitInstallBody).toContain("clearing node_modules and retrying once");
    expect(gitInstallBody).toContain("Remove-Item -Recurse -Force node_modules");
    expect(gitInstallBody).toContain('Write-Host "[!] pnpm install failed for the Git checkout"');
    expect(gitInstallBody).not.toContain("$pnpmCommand rebuild --pending");
    expect(gitInstallBody).not.toContain("scripts/postinstall-bundled-plugins.mjs");
    expect(gitInstallBody).toContain(
      "$env:NODE_OPTIONS = Resolve-NodeOptionsWithMinOldSpace -NodeOptions $prevNodeOptions -MinOldSpaceMb 8192",
    );
    expect(gitInstallBody).toMatch(/& \$pnpmCommand ui:build\s+if \(\$LASTEXITCODE -ne 0\)/);
    expect(gitInstallBody).not.toContain("if (-not (& $pnpmCommand ui:build))");
    expect(nodeOptionsBody).toContain("--max-old-space-size=$MinOldSpaceMb");
    expect(nodeOptionsBody).toContain("[Math]::Max");
    expect(gitInstallBody).toContain("& $pnpmCommand build");
    expect(gitInstallBody).toContain("$env:NODE_OPTIONS = $prevNodeOptions");
    expect(gitInstallBody).toContain(
      "$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = $prevPnpmVerifyDepsBeforeRun",
    );
    expect(gitInstallBody).toContain(
      "$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = $prevPnpmWorkspaceConcurrency",
    );
    expect(gitInstallBody).toContain("Add-ToUserPath $binDir");
    expect(gitInstallBody).toContain('Write-Host "[!] pnpm build failed for the Git checkout"');
    expect(gitInstallBody).toContain('$entryPath = Join-Path $RepoDir "dist\\\\entry.js"');
    expect(gitInstallBody).toContain("Test-Path $entryPath");
    expect(gitInstallBody).toContain('Write-Host "[!] OpenClaw build did not produce $entryPath"');
    expect(gitInstallBody).toContain("node $entryPath --version");
    expect(gitInstallBody).toContain("Format-OpenClawGitWrapper -EntryPath $entryPath");
    expect(gitInstallBody).not.toContain("& $pnpmCommand -C $RepoDir install");
  });

  it("cleans legacy git submodules only from the selected git checkout", () => {
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const mainBody = extractFunctionBody(source, "Main");
    expect(gitInstallBody).toContain("Remove-LegacySubmodule -RepoDir $RepoDir");
    expect(mainBody).not.toContain("Remove-LegacySubmodule");
  });

  it("launches interactive onboarding outside Main's captured output", () => {
    const interactiveCommandBody = extractFunctionBody(source, "Invoke-InteractiveOpenClawCommand");
    const mainBody = extractFunctionBody(source, "Main");
    expect(interactiveCommandBody).toContain("Start-Process");
    expect(interactiveCommandBody).toContain("-NoNewWindow");
    expect(interactiveCommandBody).toContain("-Wait");
    expect(interactiveCommandBody).toContain("-PassThru");
    expect(interactiveCommandBody).toContain("$process.ExitCode -ne 0");
    expect(interactiveCommandBody).toContain("failed with exit code");
    expect(mainBody).toContain('Write-Host "Starting setup..." -ForegroundColor Cyan');
    expect(mainBody).toContain("Invoke-InteractiveOpenClawCommand onboard");
  });
});
