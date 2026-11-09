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
  filter_fetch=
  projection_fetch=
  explicit_filter=
  fetch_filter=
  fetch_depth=
  shallow_change=
  argument_count=$#
  while [ "$#" -gt 0 ]; do
    case $1 in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env) [ "$#" -ge 2 ] || return 1; shift 2 ;;
      -C*|-c*) shift ;;
      --*) shift ;;
      -p|-P) shift ;;
      fetch|pull)
        global_count=$((argument_count - $#))
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
        shift
        for arg do case $arg in -e|-t) return 0 ;; esac; done
        return 1 ;;
      rev-parse)
        shift
        for arg do case $arg in --verify) return 0 ;; esac; done
        return 1 ;;
      merge-base)
        probe_kind=ancestor
        shift
        for arg do case $arg in --is-ancestor) return 0 ;; esac; done
        return 1 ;;
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
    common) git "$@" rev-parse --path-format=absolute --git-common-dir ;;
    blobless) git "$@" config --get-regexp '^remote\\..*\\.partialclonefilter$' '^blob:none$' >/dev/null 2>&1 ;;
  esac
}
check_shared_shallow() {
  common=$(query_repository common "$@" 2>/dev/null) || return 0
  # Both the primary checkout and its linked worktrees share this shallow file.
  for linked in "$common"/worktrees/*/gitdir; do
    if [ -f "$linked" ]; then
      echo 'OpenClaw: shallow-changing fetch/pull would alter history shared by linked worktrees; command not run. Fetch without shallow options for new tips. For older history, use gh api repos/<owner>/<repo>/commits/<sha> or gh api repos/<owner>/<repo>/compare/<base>...<head>; for local history, ask the operator to repair the managed base with openclaw doctor --fix, then retry git log.' >&2
      return 1
    fi
  done
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
