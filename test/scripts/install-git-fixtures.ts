export function createInstallGitCommitFixtureScript(source: "bundle" | "remote") {
  return `
    set -euo pipefail
    source "$OPENCLAW_INSTALLER_SCRIPT"
    run_quiet_step() { shift; "$@"; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    seed="$tmp/seed"
    repo="$tmp/repo"
    git init -q --initial-branch=main "$seed"
    git -C "$seed" config user.email test@example.invalid
    git -C "$seed" config user.name test
    printf 'base\\n' > "$seed/state.txt"
    git -C "$seed" add state.txt
    git -C "$seed" commit -qm base
    base="$(git -C "$seed" rev-parse HEAD)"
    git -C "$seed" bundle create "$tmp/source.bundle" HEAD
    git clone -q "$tmp/source.bundle" "$repo"
    selected="$base"
    if [[ "${source}" == remote ]]; then
      git init --bare -q "$tmp/remote.git"
      git -C "$seed" remote add origin "$tmp/remote.git"
      printf 'selected\\n' > "$seed/state.txt"
      git -C "$seed" commit -qam selected
      selected="$(git -C "$seed" rev-parse HEAD)"
      git -C "$seed" update-ref "refs/heads/$selected" "$base"
      git -C "$seed" push -q origin main "refs/heads/$selected"
      git -C "$repo" remote set-url origin "$tmp/remote.git"
      if git -C "$repo" cat-file -e "$selected" 2>/dev/null; then
        echo "fixture already has the requested commit"
        exit 1
      fi
    fi
    GIT_UPDATE=0
    checkout_git_openclaw_ref "$repo" "$selected"
    [[ "$(git -C "$repo" rev-parse HEAD)" == "$selected" ]]
    [[ -z "$(git -C "$repo" symbolic-ref --quiet HEAD || true)" ]]
    [[ "$GIT_REF_KIND" == immutable ]]
    [[ "$(git_install_lockfile_flag "$GIT_REF_KIND")" == --frozen-lockfile ]]
    printf 'selected=%s kind=%s\\n' "$selected" "$GIT_REF_KIND"
    blob="$(git -C "$repo" rev-parse HEAD:state.txt)"
    for rejected in "$blob" 0000000000000000000000000000000000000001 'HEAD~1'; do
      if (checkout_git_openclaw_ref "$repo" "$rejected") >"$tmp/rejected.log" 2>&1; then
        cat "$tmp/rejected.log"
        echo "unexpectedly accepted $rejected"
        exit 1
      fi
      [[ -s "$tmp/rejected.log" ]]
      [[ "$(git -C "$repo" rev-parse HEAD)" == "$selected" ]]
      [[ -z "$(git -C "$repo" status --porcelain)" ]]
      printf 'rejected=%s\\n' "$rejected"
    done
  `;
}

export function createInstallGitTagPreferenceFixtureScript(scriptPath: string, setup = "") {
  return `
      set -euo pipefail
      source "${scriptPath}"${setup}
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      remote="$tmp/remote.git"
      seed="$tmp/seed"
      repo="$tmp/repo"
      ref=v2026.5.12
      git init --bare -q "$remote"
      git init -q --initial-branch=main "$seed"
      git -C "$seed" config user.email test@example.invalid
      git -C "$seed" config user.name test
      printf 'tag\n' > "$seed/state.txt"
      git -C "$seed" add state.txt
      git -C "$seed" commit -qm tag
      tag_head="$(git -C "$seed" rev-parse HEAD)"
      git -C "$seed" remote add origin "$remote"
      git -C "$seed" push -q -u origin main
      git -C "$seed" tag "$ref"
      git -C "$seed" push -q origin "refs/tags/$ref"
      git -C "$seed" checkout -qb "$ref"
      printf 'branch\n' > "$seed/state.txt"
      git -C "$seed" commit -qam branch
      branch_head="$(git -C "$seed" rev-parse HEAD)"
      git -C "$seed" push -q origin "refs/heads/$ref"
      git clone -q "$remote" "$repo"
      checkout_git_openclaw_ref "$repo" "$ref"
      selected="$(git -C "$repo" rev-parse HEAD)"
      printf 'selected=%s tag=%s branch=%s kind=%s\n' "$selected" "$tag_head" "$branch_head" "$GIT_REF_KIND"
      [[ "$selected" == "$tag_head" && "$selected" != "$branch_head" && "$GIT_REF_KIND" == "immutable" ]]
    `;
}

export function createInstallGitBranchFallbackFixtureScript(scriptPath: string, setup = "") {
  return `
      set -euo pipefail
      source "${scriptPath}"${setup}
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      remote="$tmp/remote.git"
      seed="$tmp/seed"
      repo="$tmp/repo"
      ref=v2-hotfix
      git init --bare -q "$remote"
      git init -q --initial-branch=main "$seed"
      git -C "$seed" config user.email test@example.invalid
      git -C "$seed" config user.name test
      printf 'base\\n' > "$seed/state.txt"
      git -C "$seed" add state.txt
      git -C "$seed" commit -qm base
      git -C "$seed" remote add origin "$remote"
      git -C "$seed" push -q -u origin main
      git -C "$seed" checkout -qb "$ref"
      printf 'branch\\n' > "$seed/state.txt"
      git -C "$seed" commit -qam branch
      branch_head="$(git -C "$seed" rev-parse HEAD)"
      git -C "$seed" push -q origin "refs/heads/$ref"
      git clone -q "$remote" "$repo"
      checkout_git_openclaw_ref "$repo" "$ref"
      selected="$(git -C "$repo" rev-parse HEAD)"
      printf 'selected=%s branch=%s kind=%s\\n' "$selected" "$branch_head" "$GIT_REF_KIND"
      [[ "$selected" == "$branch_head" && "$GIT_REF_KIND" == "moving" ]]
    `;
}

export function createInstallGitUpdateFixtureScript(scriptPath: string, beforeUpdate = "") {
  return `
      set -euo pipefail
      source "${scriptPath}"
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      remote="$tmp/remote.git"
      source_repo="$tmp/source"
      repo="$tmp/repo"
      git init --bare -q "$remote"
      git init -q --initial-branch=main "$source_repo"
      git -C "$source_repo" config user.email test@example.invalid
      git -C "$source_repo" config user.name test
      printf 'base\\n' > "$source_repo/state.txt"
      git -C "$source_repo" add state.txt
      git -C "$source_repo" commit -qm base
      git -C "$source_repo" remote add origin "$remote"
      git -C "$source_repo" push -q -u origin main
      git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
      git clone -q "$remote" "$repo"
      git -C "$repo" config user.email test@example.invalid
      git -C "$repo" config user.name test
      printf 'target\\n' > "$source_repo/state.txt"
      git -C "$source_repo" commit -qam target
      git -C "$source_repo" push -q origin main
      base="$(git -C "$repo" rev-parse HEAD)"
      stale_tracking="$(git -C "$repo" rev-parse refs/remotes/origin/main)"
      [[ "$base" == "$stale_tracking" ]]${beforeUpdate}
      GIT_UPDATE=1
      checkout_git_openclaw_ref "$repo" main
      head="$(git -C "$repo" rev-parse HEAD)"
      tracking="$(git -C "$repo" rev-parse refs/remotes/origin/main)"
      remote_head="$(git --git-dir="$remote" rev-parse refs/heads/main)"
      printf 'head=%s\\ntracking=%s\\nremote=%s\\n' "$head" "$tracking" "$remote_head"
      [[ "$head" == "$remote_head" && "$tracking" == "$remote_head" && "$head" != "$base" ]]
    `;
}

export function createInstallGitRebaseRecoveryFixtureScript(scriptPath: string) {
  return `
      set -euo pipefail
      source "${scriptPath}"
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      remote="$tmp/remote.git"
      seed="$tmp/seed"
      repo="$tmp/repo"
      git init --bare -q "$remote"
      git init -q --initial-branch=main "$seed"
      git -C "$seed" config user.email test@example.invalid
      git -C "$seed" config user.name test
      printf 'base\\n' > "$seed/state.txt"
      git -C "$seed" add state.txt
      git -C "$seed" commit -qm base
      git -C "$seed" remote add origin "$remote"
      git -C "$seed" push -q -u origin main
      git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
      git clone -q "$remote" "$repo"
      git -C "$repo" config user.email test@example.invalid
      git -C "$repo" config user.name test
      printf 'remote\\n' > "$seed/state.txt"
      git -C "$seed" commit -qam remote
      git -C "$seed" push -q origin main
      printf 'local\\n' > "$repo/state.txt"
      git -C "$repo" commit -qam local
      printf 'keep this user change\\n' > "$repo/user-note.txt"
      expected_head="$(git -C "$repo" rev-parse HEAD)"
      expected_status="$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"
      set +e
      output="$(checkout_git_openclaw_ref "$repo" main 2>&1)"
      status=$?
      set -e
      [[ "$status" -ne 0 ]]
      actual_head="$(git -C "$repo" rev-parse HEAD)"
      actual_status="$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"
      rebase_merge="$(git -C "$repo" rev-parse --git-path rebase-merge)"
      rebase_apply="$(git -C "$repo" rev-parse --git-path rebase-apply)"
      [[ "$actual_head" == "$expected_head" ]]
      [[ "$actual_status" == "$expected_status" ]]
      [[ "$(cat "$repo/user-note.txt")" == "keep this user change" ]]
      [[ ! -d "$rebase_merge" && ! -d "$rebase_apply" ]]
      [[ "$output" == *"restored to its pre-update state"* ]]
      printf 'recovery=head-restored status-clean rebase-state-cleared\\n'
    `;
}

export function createInstallGitHookRefusalFixtureScript(scriptPath: string, setup = "") {
  return `
      set -euo pipefail
      source "${scriptPath}"${setup}
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      remote="$tmp/remote.git"
      seed="$tmp/seed"
      repo="$tmp/repo"
      git init --bare -q "$remote"
      git init -q --initial-branch=main "$seed"
      git -C "$seed" config user.email test@example.invalid
      git -C "$seed" config user.name test
      printf 'base\\n' > "$seed/state.txt"
      git -C "$seed" add state.txt
      git -C "$seed" commit -qm base
      git -C "$seed" remote add origin "$remote"
      git -C "$seed" push -q -u origin main
      git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
      git clone -q "$remote" "$repo"
      printf 'remote\\n' > "$seed/state.txt"
      git -C "$seed" commit -qam remote
      git -C "$seed" push -q origin main
      git -C "$repo" config user.email test@example.invalid
      git -C "$repo" config user.name test
      printf 'local\\n' > "$repo/local.txt"
      git -C "$repo" add local.txt
      git -C "$repo" commit -qm local
      cat > "$repo/.git/hooks/pre-rebase" <<'HOOK'
#!/usr/bin/env bash
exit 42
HOOK
      chmod +x "$repo/.git/hooks/pre-rebase"
      printf 'keep this user change\\n' > "$repo/user-note.txt"
      expected_head="$(git -C "$repo" rev-parse HEAD)"
      expected_status="$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"
      set +e
      output="$(GIT_UPDATE=1 checkout_git_openclaw_ref "$repo" main 2>&1)"
      status=$?
      set -e
      actual_head="$(git -C "$repo" rev-parse HEAD)"
      actual_status="$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"
      rebase_merge="$(git -C "$repo" rev-parse --git-path rebase-merge)"
      rebase_apply="$(git -C "$repo" rev-parse --git-path rebase-apply)"
      [[ "$status" -ne 0 ]]
      [[ "$actual_head" == "$expected_head" ]]
      [[ "$actual_status" == "$expected_status" ]]
      [[ "$(cat "$repo/user-note.txt")" == "keep this user change" ]]
      [[ ! -d "$rebase_merge" && ! -d "$rebase_apply" ]]
      [[ "$output" == *"restored to its pre-update state"* ]]
      printf 'hook-refusal=head-verified status-verified rebase-state-absent\\n'
    `;
}

export function createInstallGitCloneFixtureScript(
  scriptPath: string,
  setup: string,
  cloneOptions = "",
) {
  return `
      set -euo pipefail
      source "${scriptPath}"
${setup}
      git() {
        local target="\${*: -1}"
        mkdir -p "$target/.git"
        printf 'complete\\n' > "$target/checkout.marker"
        if [[ "$CLONE_MODE" == "failure" ]]; then
          return 42
        fi
        if [[ "$CLONE_MODE" == "concurrent" ]]; then
          mkdir -p "$CONCURRENT_REPO"
          printf 'keep\\n' > "$CONCURRENT_REPO/user.marker"
        fi
        if [[ "$CLONE_MODE" == "retarget-alias" ]]; then
          [[ "$(dirname "$target")" == "$ALIAS_TARGET" ]]
          rm "$ALIAS_PATH"
          ln -s "$ALIAS_REPLACEMENT" "$ALIAS_PATH"
        fi
      }

      CLONE_MODE=success
      success_repo="$root/success"
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$success_repo" ${cloneOptions}
      [[ -f "$success_repo/checkout.marker" ]]

      CLONE_MODE=failure
      failed_repo="$root/failure"
      set +e
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$failed_repo"
      failure_status="$?"
      set -e
      [[ "$failure_status" -eq 42 ]]
      [[ ! -e "$failed_repo" ]]

      CLONE_MODE=retarget-alias
      ALIAS_TARGET="$root/alias-target"
      ALIAS_REPLACEMENT="$root/alias-replacement"
      ALIAS_PATH="$root/alias"
      mkdir -p "$ALIAS_TARGET" "$ALIAS_REPLACEMENT"
      ln -s "$ALIAS_TARGET" "$ALIAS_PATH"
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$ALIAS_PATH"
      [[ -f "$ALIAS_TARGET/checkout.marker" ]]
      [[ -z "$(ls -A "$ALIAS_REPLACEMENT")" ]]
      [[ -z "$(find "$ALIAS_TARGET" -maxdepth 1 -name '.openclaw-clone.*' -print -quit)" ]]

      CLONE_MODE=concurrent
      CONCURRENT_REPO="$root/concurrent"
  `;
}
