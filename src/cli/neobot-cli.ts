import type { Command } from "commander";
import { registerQrCli } from "./qr-cli.js";

export function registerNeobotCli(program: Command) {
  const neobot = program.command("neobot").description("Legacy neobot command aliases");
  registerQrCli(neobot);
}
