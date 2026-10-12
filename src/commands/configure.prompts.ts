import type { RuntimeEnv } from "../runtime.js";
import { confirm, password, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

export function createConfigurePrompts(runtime: RuntimeEnv) {
  return {
    text: async (params: Parameters<typeof text>[0]) => guardCancel(await text(params), runtime, 1),
    password: async (params: Parameters<typeof password>[0]) =>
      guardCancel(await password(params), runtime, 1),
    confirm: async (params: Parameters<typeof confirm>[0]) =>
      guardCancel(await confirm(params), runtime, 1),
    select: async <T>(params: Parameters<typeof select<T>>[0]) =>
      guardCancel(await select<T>(params), runtime, 1),
  };
}
