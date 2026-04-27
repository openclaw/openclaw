import type { Command } from "commander";
type RegisterLazyCommandParams = {
    program: Command;
    name: string;
    description: string;
    removeNames?: string[];
    register: () => Promise<void> | void;
};
export declare function registerLazyCommand({ program, name, description, removeNames, register, }: RegisterLazyCommandParams): void;
export {};
