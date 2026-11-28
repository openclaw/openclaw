import { isWSLEnv } from "./wsl.js";

export function isRemoteEnvironment(): boolean {
  return Boolean(
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION ||
    process.env.REMOTE_CONTAINERS ||
    process.env.CODESPACES ||
    (process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY &&
      !isWSLEnv()),
  );
}
