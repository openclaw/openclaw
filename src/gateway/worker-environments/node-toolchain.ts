import { PROCESS_NODE_VERSION_CHECK } from "../../../node-version.mjs";

// Development/CI pin; digests: https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
const DEFAULT_NODE_VERSION = "24.21.0";
const DEFAULT_NODE_SHA256 = {
  x64: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
  arm64: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
};

/** Shared installer body for bootstrap and repository releases; stdout is the bin path. */
export const NODE_TOOLCHAIN_INSTALL_SH = `set -eu
openclaw_install_node() (
  umask 077
  version="$1"; digest="$2"
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Cloud worker Node toolchain: unsupported Linux architecture; supply Node in the image or profile setup' >&2; exit 1;; esac
  case "$version" in *[!0-9.]*|'') echo 'Cloud worker Node toolchain: invalid release; fix the repository Node declaration' >&2; exit 1;; esac
  case "$digest" in *[!a-f0-9]*|'') exit 1;; esac
  [ "$(printf '%s' "$digest" | wc -c | tr -d ' ')" = 64 ] || exit 1
  root="$HOME/.openclaw-worker/toolchains/node"
  mkdir -p "$root"
  destination="$root/$version-linux-$arch-$digest"
  if [ -s "$destination/.files.sha256" ] && (cd "$destination" && sha256sum --status -c .files.sha256) && [ "$("$destination/bin/node" --version)" = "v$version" ]; then
    printf '%s\\n' "$destination/bin"
    exit 0
  fi
  for tool in curl tar sha256sum; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "Cloud worker Node toolchain requires $tool; add it to the image or optional profile setup and retry" >&2; exit 1
    fi
  done
  stage="$(mktemp -d "$root/.install-XXXXXX")"
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  archive="node-v$version-linux-$arch.tar.gz"
  if ! curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 30 --max-time 600 "https://nodejs.org/dist/v$version/$archive" -o "$stage/node.tgz"; then
    echo 'Cloud worker Node toolchain download failed; allow HTTPS access to nodejs.org and retry preparation' >&2; exit 1
  fi
  if ! printf '%s  %s\\n' "$digest" "$stage/node.tgz" | sha256sum --status -c -; then
    echo 'Cloud worker Node toolchain SHA-256 verification failed; check the download proxy and retry preparation' >&2; exit 1
  fi
  mkdir "$stage/release"
  tar -xzf "$stage/node.tgz" --strip-components=1 -C "$stage/release"
  if [ "$("$stage/release/bin/node" --version)" != "v$version" ]; then
    echo 'Cloud worker Node toolchain cannot execute; use a glibc Linux image compatible with official Node.js releases' >&2; exit 1
  fi
  (cd "$stage/release" && find . -type f ! -name .files.sha256 -exec sha256sum {} + > .files.sha256)
  rm -rf "$destination"
  mv "$stage/release" "$destination"
  printf '%s\\n' "$destination/bin"
)
`;

/** Linux bootstrap only. Other platforms retain their image-provided Node contract. */
export const DEFAULT_NODE_TOOLCHAIN_SETUP_SH = `${NODE_TOOLCHAIN_INSTALL_SH}
if [ "$(uname -s)" = Linux ]; then
  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(${PROCESS_NODE_VERSION_CHECK} ? 0 : 1)' || ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1 || ! command -v corepack >/dev/null 2>&1; then
    case "$(uname -m)" in
      x86_64) node_digest=${DEFAULT_NODE_SHA256.x64};;
      aarch64|arm64) node_digest=${DEFAULT_NODE_SHA256.arm64};;
      *) echo 'Cloud worker Node toolchain: unsupported Linux architecture; supply Node in the image or profile setup' >&2; exit 1;;
    esac
    node_bin="$(openclaw_install_node ${DEFAULT_NODE_VERSION} "$node_digest")"
    PATH="$node_bin:$PATH"
    export PATH
  fi
fi
`;
