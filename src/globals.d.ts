export { isVerbose, isYes, setVerbose, setYes } from "./global-state.js";
export declare function shouldLogVerbose(): boolean;
export declare function logVerbose(message: string): void;
export declare function logVerboseConsole(message: string): void;
type ThemeFormatter = (value: string) => string;
export declare const success: ThemeFormatter;
export declare const warn: ThemeFormatter;
export declare const info: ThemeFormatter;
export declare const danger: ThemeFormatter;
