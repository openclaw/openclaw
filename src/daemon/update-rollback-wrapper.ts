/** Generates the POSIX service supervisor that consumes one package update rollback marker. */

const DEFAULT_UPDATE_HEALTH_TIMEOUT_SECONDS = 60;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildUpdateRollbackSupervisorScript(params: {
  markerPath: string;
  healthTimeoutSeconds?: number;
  loadEnvironmentFile?: boolean;
}): string {
  const timeout = params.healthTimeoutSeconds ?? DEFAULT_UPDATE_HEALTH_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("Invalid update rollback health timeout");
  }
  const markerPath = shellQuote(params.markerPath);
  const loadEnvironment = params.loadEnvironmentFile
    ? `env_file="$1"
shift
if [ -f "$env_file" ]; then
  . "$env_file"
fi
`
    : "";
  return `#!/bin/sh
set -eu
${loadEnvironment}marker_path=${markerPath}

if [ ! -f "$marker_path" ]; then
  exec "$@"
fi

marker_version=
marker_state=
new_version=
previous_version=
current_root=
retained_root=
gateway_port=
rollback_error=
while IFS='=' read -r marker_key marker_value; do
  case "$marker_key" in
    version) marker_version="$marker_value" ;;
    state) marker_state="$marker_value" ;;
    new_version) new_version="$marker_value" ;;
    previous_version) previous_version="$marker_value" ;;
    current_root) current_root="$marker_value" ;;
    retained_root) retained_root="$marker_value" ;;
    gateway_port) gateway_port="$marker_value" ;;
    error) rollback_error="$marker_value" ;;
  esac
done < "$marker_path"

case "$current_root" in /*) ;; *) exec "$@" ;; esac
case "$retained_root" in /*) ;; *) exec "$@" ;; esac
case "$gateway_port" in ''|*[!0-9]*) exec "$@" ;; esac
if [ "$marker_version" != 1 ] || [ "$current_root" = / ] || [ "$retained_root" = / ] || [ "$current_root" = "$retained_root" ]; then
  exec "$@"
fi
if [ "$marker_state" = rolled_back ]; then
  exec "$@"
fi
if [ "$marker_state" != pending ]; then
  exec "$@"
fi
if [ "\${OPENCLAW_UPDATE_NO_ROLLBACK:-0}" = 1 ]; then
  rm -f "$marker_path"
  exec "$@"
fi

gateway_pid=
shutdown_requested=0
forward_shutdown() {
  shutdown_requested=1
  if [ -n "$gateway_pid" ]; then
    kill -TERM "$gateway_pid" 2>/dev/null || true
  fi
}
trap forward_shutdown TERM INT HUP

probe_ready() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$gateway_port/readyz" >/dev/null 2>&1
    return $?
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const http=require("node:http");const req=http.get({hostname:"127.0.0.1",port:Number(process.argv[1]),path:"/readyz"},(res)=>{res.resume();process.exit(res.statusCode===200?0:1)});req.setTimeout(2000,()=>req.destroy());req.on("error",()=>process.exit(1));' "$gateway_port" >/dev/null 2>&1
    return $?
  fi
  return 1
}

"$@" &
gateway_pid=$!
healthy=0
attempt=0
while [ "$attempt" -lt ${timeout} ]; do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    wait "$gateway_pid" || gateway_exit=$?
    if [ "$shutdown_requested" = 1 ]; then
      exit "\${gateway_exit:-0}"
    fi
    rollback_error="gateway exited with status \${gateway_exit:-unknown} before readiness"
    break
  fi
  if probe_ready; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$shutdown_requested" = 1 ]; then
  wait "$gateway_pid" 2>/dev/null || gateway_exit=$?
  exit "\${gateway_exit:-0}"
fi

if [ "$healthy" = 1 ]; then
  rm -f "$marker_path"
  wait "$gateway_pid"
  exit $?
fi

if [ -z "$rollback_error" ]; then
  rollback_error="gateway did not become ready within ${timeout} seconds"
fi
kill "$gateway_pid" 2>/dev/null || true
wait "$gateway_pid" 2>/dev/null || true

# Package replacement is one short critical section. The service manager can
# still force-kill the whole job after its normal stop timeout.
trap '' TERM INT HUP
restore_root="\${current_root}.openclaw-restore-$$"
failed_root="\${current_root}.openclaw-failed-$$"
rm -rf "$restore_root" "$failed_root"
if ! cp -R "$retained_root" "$restore_root"; then
  echo "OpenClaw rollback copy failed: $retained_root -> $restore_root" >&2
  exit 1
fi
if ! mv "$current_root" "$failed_root"; then
  rm -rf "$restore_root"
  echo "OpenClaw rollback could not move failed package: $current_root" >&2
  exit 1
fi
if ! mv "$restore_root" "$current_root"; then
  mv "$failed_root" "$current_root" 2>/dev/null || true
  echo "OpenClaw rollback could not activate retained package: $current_root" >&2
  exit 1
fi
rm -rf "$failed_root"

marker_tmp="\${marker_path}.$$"
{
  printf '%s\n' 'version=1' 'state=rolled_back'
  printf 'new_version=%s\n' "$new_version"
  printf 'previous_version=%s\n' "$previous_version"
  printf 'current_root=%s\n' "$current_root"
  printf 'retained_root=%s\n' "$retained_root"
  printf 'gateway_port=%s\n' "$gateway_port"
  printf 'error=%s\n' "$rollback_error"
} > "$marker_tmp"
chmod 600 "$marker_tmp"
mv "$marker_tmp" "$marker_path"
echo "OpenClaw update rollback: $rollback_error; restored $previous_version" >&2
exec "$@"
`;
}
