// Applies OpenClaw's default fs-safe runtime configuration.
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

export { configureFsSafeNative };

// Windows secure reads need descriptor-bound native ACL checks. Retain fs-safe's
// auto default there; POSIX keeps JavaScript unless an operator selects a mode.
const hasModeOverride = Object.keys(process.env).some((key) =>
  /^(?:OPENCLAW_)?FS_SAFE_(?:NATIVE|PYTHON)_MODE$/u.test(
    process.platform === "win32" ? key.toUpperCase() : key,
  ),
);

if (!hasModeOverride && process.platform !== "win32") {
  configureFsSafeNative({ mode: "off" });
}
