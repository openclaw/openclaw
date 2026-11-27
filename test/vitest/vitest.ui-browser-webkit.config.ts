// Select WebKit without host environment opt-ins, including secretless isolated runs.
import { createUiBrowserVitestConfig } from "../../ui/vitest.config.ts";

export default createUiBrowserVitestConfig(process.env, "webkit");
