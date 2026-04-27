import type { RuntimeEnv } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
export declare function configureCommand(runtime?: RuntimeEnv): Promise<void>;
export declare function configureCommandWithSections(sections: WizardSection[], runtime?: RuntimeEnv): Promise<void>;
export declare function configureCommandFromSectionsArg(rawSections: unknown, runtime?: RuntimeEnv): Promise<void>;
