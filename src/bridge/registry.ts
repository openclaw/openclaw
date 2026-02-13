import { BridgeCommand } from "./types.js";

export class CommandBridgeRegistry {
  private commands = new Map<string, BridgeCommand>();

  register<T>(command: BridgeCommand<T>) {
    if (this.commands.has(command.name)) {
      throw new Error(`Command '${command.name}' is already registered.`);
    }
    this.commands.set(command.name, command as BridgeCommand<unknown>);
  }

  unregister(name: string): boolean {
    return this.commands.delete(name);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  get(name: string): BridgeCommand | undefined {
    return this.commands.get(name);
  }

  getAll(): BridgeCommand[] {
    return Array.from(this.commands.values());
  }

  clear(): void {
    this.commands.clear();
  }
}

export const bridgeRegistry = new CommandBridgeRegistry();
