import { configureFsSafePython } from "@openclaw/fs-safe/config";

let configuredPythonAuto = false;

export function ensureFsSafeDefaults(): void {
  const hasPythonModeOverride =
    process.env.FS_SAFE_PYTHON_MODE != null || process.env.OPENCLAW_FS_SAFE_PYTHON_MODE != null;
  if (hasPythonModeOverride) {
    return;
  }

  process.env.FS_SAFE_PYTHON_MODE = "auto";
  if (!configuredPythonAuto) {
    configureFsSafePython({ mode: "auto" });
    configuredPythonAuto = true;
  }
}

ensureFsSafeDefaults();
