export const AGENT_GIT_SANDBOX_BIN = "/openclaw/git-tools";

/** A PATH tool contract: local probes, shared history, and partial-clone fetches/hydration. */
export const AGENT_GIT_SHIM = `#!/bin/sh
shim_dir=\${0%/*}
search_path=
separator=
remaining=$PATH
while :; do
  entry=\${remaining%%:*}
  if [ "$entry" != "$shim_dir" ]; then
    search_path=$search_path$separator$entry
    separator=:
  fi
  case $remaining in *:*) remaining=\${remaining#*:} ;; *) break ;; esac
done
PATH=$search_path
export PATH
is_probe() {
  prepare_history=
  no_lazy_fetch=
  filter_fetch=
  projection_fetch=
  explicit_filter=
  fetch_filter=
  fetch_depth=
  shallow_change=
  argument_count=$#
  while [ "$#" -gt 0 ]; do
    global_count=$((argument_count - $#))
    case $1 in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env) [ "$#" -ge 2 ] || return 1; shift 2 ;;
      -C*|-c*) shift ;;
      --no-lazy-fetch) no_lazy_fetch=1; shift ;;
      --*) shift ;;
      -p|-P) shift ;;
      fetch|pull)
        command=$1
        shift
        for arg do
          case $arg in
            --) break ;;
            --?*)
              name=\${arg%%=*}
              for option in --depth --deepen --shallow-since --shallow-exclude --unshallow --update-shallow; do
                case $option in "$name"*) shallow_change=1 ;; esac
              done ;;
          esac
        done
        [ "$command" = fetch ] || return 1
        for arg do
          case $arg in
            --) break ;;
            --all|--multiple) return 1 ;;
            --filter|--filter=*|--no-filter) explicit_filter=1 ;;
          esac
        done
        projection_fetch=1
        for arg do
          case $arg in
            https://github.com/*|git@github.com:*|ssh://git@github.com/*) filter_fetch=1 ;;
          esac
        done
        return 1 ;;
      cat-file)
        prepare_history=1
        shift
        for arg do case $arg in -e|-t) return 0 ;; esac; done
        return 1 ;;
      rev-parse)
        shift
        for arg do case $arg in --verify) return 0 ;; esac; done
        return 1 ;;
      merge-base)
        prepare_history=1
        probe_kind=ancestor
        shift
        for arg do case $arg in --is-ancestor) return 0 ;; esac; done
        return 1 ;;
      show|diff|log|rev-list|restore|checkout|switch|reset|merge|rebase|cherry-pick|revert|blame|show-branch|archive|ls-tree|format-patch|diff-tree|diff-index|read-tree)
        prepare_history=1; return 1 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
query_repository() {
  query=$1; shift
  # Keep Git's global options (-C, -c, --git-dir, ...) on repository queries.
  tail_count=$(($# - global_count))
  prefix_count=$global_count
  while [ "$prefix_count" -gt 0 ]; do
    set -- "$@" "$1"
    shift
    prefix_count=$((prefix_count - 1))
  done
  shift "$tail_count"
  case $query in
    projection) git "$@" config --bool --get openclaw.projection 2>/dev/null ;;
    shared)
      common=$(git "$@" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
      for linked in "$common"/worktrees/*/gitdir; do
        if [ -f "$linked" ]; then return 0; fi
      done
      return 1 ;;
    blobless) git "$@" config --get-regexp '^remote\\..*\\.partialclonefilter$' '^blob:none$' >/dev/null 2>&1 ;;
    objects) GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= exec git "$@" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null ;;
    resolve) GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= exec git "$@" rev-parse --verify --end-of-options "$revision" 2>/dev/null ;;
    fetch)
      GIT_NO_LAZY_FETCH=1 git "$@" -c fetch.negotiationAlgorithm=consecutive fetch --filter=blob:none --no-tags --no-write-fetch-head --no-auto-maintenance --recurse-submodules=no origin --stdin <<EOF
$missing
EOF
      ;;
  esac
}
revision_roots() {
  revisions=
  shift "$global_count"
  verb=$1; shift
  while [ "$#" -gt 0 ]; do
    arg=$1; shift
    case $verb:$arg in
      checkout:-b|checkout:-B|switch:-c|switch:-C|merge:-m|merge:-F|cherry-pick:-m|revert:-m|log:-n|show:-n|rev-list:-n)
        [ "$#" -gt 0 ] && shift; continue ;;
      cat-file:blob|cat-file:tree|cat-file:commit|cat-file:tag) continue ;;
      diff:--no-index|archive:--remote|archive:--remote=*) revisions=; return ;;
      archive:--format|ls-tree:--format|format-patch:-o|format-patch:--cc) [ "$#" -gt 0 ] && shift; continue ;;
      restore:-S|merge:-S|rebase:-S|cherry-pick:-S|revert:-S) continue ;;
    esac
    case $arg in
      --) break ;;
      --source|--onto) [ "$#" -gt 0 ] || break; arg=$1; shift ;;
      --source=*|--onto=*) arg=\${arg#*=} ;;
      -s)
        if [ "$verb" != restore ]; then
          case $verb in merge|rebase) [ "$#" -gt 0 ] && shift ;; esac
          continue
        fi
        [ "$#" -gt 0 ] || break; arg=$1; shift ;;
      -s*) [ "$verb" = restore ] || continue; arg=\${arg#-s} ;;
      --grep|--grep-reflog|--author|--committer|--since|--since-as-filter|--until|--after|--before|--max-count|--max-count-oldest|--max-age|--min-age|--skip|--output|--output-directory|--path|--pathspec-from-file|--date|--encoding|--diff-filter|--find-object|--strategy|--strategy-option|--message|--file|--mainline|--glob|--exclude|--exclude-hidden|--create|--force-create|--conflict|--contents|--ignore-revs-file|--exec|--into-name|--subject-prefix|--signature|--signature-file|--suffix|--to|--in-reply-to|--add-header|--prefix|--src-prefix|--dst-prefix|--line-prefix|--anchored|--word-diff-regex|-G|-S|-L|-O|-X|--orphan)
        [ "$#" -gt 0 ] && shift; continue ;;
      -*) continue ;;
      *) [ "$verb" != restore ] || continue ;;
    esac
    # Paths and revision suffixes are consumed by Git after their root is present.
    arg=\${arg%%:*}
    case $arg in
      *...*) left=\${arg%%...*}; right=\${arg#*...} ;;
      *..*) left=\${arg%%..*}; right=\${arg#*..} ;;
      *) left=$arg; right= ;;
    esac
    for revision in "$left" "$right"; do
      revision=\${revision#^}
      revision=\${revision%%[~^]*}
      case $revision in ''|*[[:space:]]*) continue ;; esac
      revisions="$revisions$revision
"
    done
  done
}
prepare_commits() {
  [ "$no_lazy_fetch" != 1 ] || return 0
  case \${GIT_NO_LAZY_FETCH:-} in 1|true|yes|on) return 0 ;; esac
  revision_roots "$@"
  [ -n "$revisions" ] || return 0
  # Inspect raw types so present blob/tree arguments remain ordinary content reads.
  objects=$(query_repository objects "$@" <<EOF
$revisions
EOF
  ) || return 0
  missing=
  while read -r revision kind; do
    [ "$kind" = missing ] || continue
    oid=$(query_repository resolve "$@") || continue
    if [ -z "$missing" ]; then
      query_repository blobless "$@" || return 0
      query_repository shared "$@" || return 0
      missing=$oid
    else
      missing="$missing
$oid"
    fi
  done <<EOF
$objects
EOF
  [ -n "$missing" ] || return 0
  query_repository fetch "$@" && return 0
  echo 'OpenClaw: could not fetch the requested object from origin with history negotiation; command not run. Fetch it explicitly from the remote that owns it, then retry.' >&2
  return 1
}
check_shared_shallow() {
  # Both the primary checkout and its linked worktrees share this shallow file.
  if query_repository shared "$@"; then
    echo 'OpenClaw: shallow-changing fetch/pull would alter history shared by linked worktrees; command not run. Fetch without shallow options for new tips. For older history, use gh api repos/<owner>/<repo>/commits/<sha> or gh api repos/<owner>/<repo>/compare/<base>...<head>; for local history, ask the operator to repair the managed base with openclaw doctor --fix, then retry git log.' >&2
    return 1
  fi
}
fetch_defaults() {
  if [ "$(query_repository projection "$@")" = true ]; then
    [ "$shallow_change" = 1 ] || fetch_depth=64
    [ "$explicit_filter" = 1 ] || fetch_filter=blob:none
  elif [ "$filter_fetch" = 1 ] && [ "$explicit_filter" != 1 ] && query_repository blobless "$@"; then
    fetch_filter=blob:none
  fi
}
if ! is_probe "$@"; then
  if [ "$prepare_history" = 1 ]; then prepare_commits "$@" || exit 2; fi
  if [ "$projection_fetch" = 1 ]; then fetch_defaults "$@"; fi
  if [ "$shallow_change" = 1 ] || [ -n "$fetch_depth" ]; then
    check_shared_shallow "$@" || exit 2
  fi
  if [ -n "$fetch_filter$fetch_depth" ]; then
    # Native Git owns promisor registration; only standalone projections get a depth cap.
    tail_count=$(($# - global_count - 1))
    prefix_count=$((global_count + 1))
    while [ "$prefix_count" -gt 0 ]; do
      set -- "$@" "$1"; shift; prefix_count=$((prefix_count - 1))
    done
    [ -z "$fetch_filter" ] || set -- "$@" "--filter=$fetch_filter"
    [ -z "$fetch_depth" ] || set -- "$@" "--depth=$fetch_depth"
    while [ "$tail_count" -gt 0 ]; do
      set -- "$@" "$1"; shift; tail_count=$((tail_count - 1))
    done
    exec git "$@"
  fi
  exec git "$@"
fi
# Older Git ignores GIT_NO_LAZY_FETCH; transport denial still keeps probes offline.
GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= git "$@"
result=$?
if [ "$result" -ne 0 ] && { [ "$result" -ne 1 ] || [ "$probe_kind" != ancestor ]; }; then
  echo 'OpenClaw: Git probe ran offline. If the commit is missing, fetch explicitly with a known local common tip: git fetch origin <sha> --negotiation-tip=origin/main; or use gh api repos/<owner>/<repo>/commits/<sha> (compare/<base>...<head> for ancestry). Then retry. Content reads such as git show still hydrate blobs normally.' >&2
fi
exit "$result"
`;
