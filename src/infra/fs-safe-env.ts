const nativeModeKey = "OPENCLAW_FS_SAFE_NATIVE_MODE";
const legacyModeKeys = ["FS_SAFE_PYTHON_MODE", "OPENCLAW_FS_SAFE_PYTHON_MODE"] as const;
const legacyKeys = [
  ...legacyModeKeys,
  "FS_SAFE_PYTHON",
  "OPENCLAW_FS_SAFE_PYTHON",
  "OPENCLAW_PINNED_PYTHON",
  "OPENCLAW_PINNED_WRITE_PYTHON",
] as const;

type NativeModeFallback = {
  key: string;
  value: string;
  previous: string | undefined;
  existed: boolean;
};
// This records only a derived env slot. Config/dotenv owners retain authority over
// the original inputs, and their snapshots must not adopt the derived value.
const fallbacks = new WeakMap<NodeJS.ProcessEnv, NativeModeFallback>();
let warned = false;

function nativeModeIsValid(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^(?:0|false|off|never|1|true|on|auto|required|require)$/u.test(normalized);
}

function currentFallback(env: NodeJS.ProcessEnv): NativeModeFallback | undefined {
  const fallback = fallbacks.get(env);
  return fallback && env[fallback.key] === fallback.value ? fallback : undefined;
}

/** Read the operator/config inputs without promoting a derived native fallback. */
export function fsSafeEnvInput(env: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const fallback = currentFallback(env);
  if (!fallback) {
    return env;
  }
  const input = { ...env, [fallback.key]: fallback.previous };
  if (!fallback.existed) {
    delete input[fallback.key];
  }
  return input;
}

/** Retire our unchanged projection before an environment owner writes real inputs. */
export function clearFsSafeEnvFallback(env: NodeJS.ProcessEnv): void {
  const fallback = currentFallback(env);
  fallbacks.delete(env);
  if (!fallback) {
    return;
  }
  if (!fallback.existed) {
    delete env[fallback.key];
  } else {
    env[fallback.key] = fallback.previous;
  }
}

/** Preserve OpenClaw's retired Python mode env contract below both native names. */
export function normalizeFsSafeNativeEnv(env: NodeJS.ProcessEnv = process.env): void {
  clearFsSafeEnvFallback(env);
  const configured = legacyKeys.filter((key) => env[key] !== undefined);
  if (configured.length && env === process.env && !warned) {
    warned = true;
    process.emitWarning(
      `${configured.join(", ")} is deprecated. OpenClaw maps legacy mode values to native ` +
        "mode only when neither FS_SAFE_NATIVE_MODE nor OPENCLAW_FS_SAFE_NATIVE_MODE selects " +
        "a mode. Replace Python mode variables with native mode variables; interpreter " +
        "path settings are ignored.",
      { code: "FS_SAFE_PYTHON_DEPRECATED", type: "DeprecationWarning" },
    );
  }
  if (nativeModeIsValid(env.FS_SAFE_NATIVE_MODE) || nativeModeIsValid(env[nativeModeKey])) {
    return;
  }
  // fs-safe's retired bridge chose the first defined legacy name, even if blank
  // or invalid. Keep its raw bytes so config ownership and rollback stay exact.
  const value = legacyModeKeys.map((key) => env[key]).find((entry) => entry !== undefined);
  if (value === undefined) {
    return;
  }
  const keys = Object.keys(env);
  // Only use a differently cased slot when this object actually aliases it.
  // Windows Worker environments and plain objects remain case-sensitive.
  const key =
    !keys.includes(nativeModeKey) && Object.hasOwn(env, nativeModeKey)
      ? (keys.find((candidate) => candidate.toUpperCase() === nativeModeKey) ?? nativeModeKey)
      : nativeModeKey;
  const existed = Object.hasOwn(env, key);
  const previous = env[key];
  env[key] = value;
  fallbacks.set(env, { key, value, previous, existed });
}
