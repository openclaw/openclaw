import os from "node:os";

const MAC_PERMISSION_MAP = {
  Accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  FullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  Automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  ScreenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
};

export function handlePermissionError(err: unknown): boolean {
  const error = err as Error & { code?: string };
  if (os.platform() !== "darwin" || error.code !== "EPERM") {
    return false;
  }

  console.error("\n❌ Permission Denied");
  console.error("OpenClaw requires system privacy permissions to control applications, access local files, and capture screen content.");
  console.error("\nEnable the required permissions below, run the corresponding command to open settings directly:");

  for (const [name, url] of Object.entries(MAC_PERMISSION_MAP)) {
    console.error(`\n[${name}]`);
    console.error(`open ${url}`);
  }

  console.error("\nRestart OpenClaw after enabling permissions and retry your operation\n");
  return true;
}
