import { pathToFileURL } from "node:url";

export function moduleNotFoundError(filePath: string): Error {
  return Object.assign(new Error(`Cannot find module '${filePath}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    url: pathToFileURL(filePath).href,
  });
}
