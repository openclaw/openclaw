import { BaseVerifier } from "../verifier.js";

export class CustomVerifier extends BaseVerifier {
  getType(): "custom" {
    return "custom";
  }

  buildCommand(): string[] {
    const command = this.gate.command;
    if (!command) {
      throw new Error("Custom gate requires a command");
    }
    return command.split(" ").filter(Boolean);
  }
}
