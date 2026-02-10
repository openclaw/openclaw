import { BridgeCommand } from "./types.js";

class CommandBridgeRegistry {
  private commands = new Map<string, BridgeCommand>();

  register<T>(command: BridgeCommand<T>) {
    if (this.commands.has(command.name)) {
      throw new Error(`Command '${command.name}' is already registered.`);
    }
    this.commands.set(command.name, command as BridgeCommand<unknown>);
  }

  get(name: string): BridgeCommand | undefined {
    return this.commands.get(name);
  }

  getAll(): BridgeCommand[] {
    return Array.from(this.commands.values());
  }
}

export const bridgeRegistry = new CommandBridgeRegistry();
