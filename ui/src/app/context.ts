import { createContext } from "@lit/context";
import type { ApplicationContext } from "./context-types.ts";

export type * from "./context-types.ts";

export const applicationContext = createContext<ApplicationContext>("openclaw.application");
