export const AGENT_GIT_SANDBOX_BIN = "/openclaw/git-tools";

/** A PATH tool contract: probes stay local; content reads retain Git's blob hydration. */
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
  while [ "$#" -gt 0 ]; do
    case $1 in
      -C|-c|--git-dir|--work-tree|--namespace) [ "$#" -ge 2 ] || return 1; shift 2 ;;
      -C*|-c*) shift ;;
      --*) shift ;;
      -p|-P) shift ;;
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
if ! is_probe "$@"; then
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
