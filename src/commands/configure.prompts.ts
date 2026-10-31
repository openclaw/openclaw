import { defaultRuntime } from "../runtime.js";
import { confirm, password, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

export const configurePrompts = {
  text: async (params: Parameters<typeof text>[0]) =>
    guardCancel(await text(params), defaultRuntime, 1),
  password: async (params: Parameters<typeof password>[0]) =>
    guardCancel(await password(params), defaultRuntime, 1),
  confirm: async (params: Parameters<typeof confirm>[0]) =>
    guardCancel(await confirm(params), defaultRuntime, 1),
  select: async <T>(params: Parameters<typeof select<T>>[0]) =>
    guardCancel(await select<T>(params), defaultRuntime, 1),
};
