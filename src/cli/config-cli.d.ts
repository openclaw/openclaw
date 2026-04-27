import type { Command } from "commander";
import { type RuntimeEnv } from "../runtime.js";
import { type ConfigSetOptions } from "./config-set-input.js";
export declare function runConfigSet(opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function runConfigGet(opts: {
    path: string;
    json?: boolean;
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function runConfigUnset(opts: {
    path: string;
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function runConfigFile(opts: {
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function runConfigSchema(opts?: {
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function runConfigValidate(opts?: {
    json?: boolean;
    runtime?: RuntimeEnv;
}): Promise<void>;
export declare function registerConfigCli(program: Command): void;
