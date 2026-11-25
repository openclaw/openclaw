import { expect, it } from "vitest";
import { parseConcreteConfigPathTokens } from "./dot-path.js";

it.each(['root["safe"//""]', "root['safe'//'']"])(
  "rejects a comment after the closing quote in %s",
  (path) => {
    expect(() => parseConcreteConfigPathTokens(path)).toThrow("Invalid path bracket string");
  },
);
