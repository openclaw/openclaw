import { expect, it } from "vitest";
import {
  estimateControlUiBrowserSupport as estimate,
  type ControlUiBrowserFamily,
} from "./control-ui-browser-requirements.js";

it.each<[ControlUiBrowserFamily, string, string]>([
  ["safari", "18.5", "unsupported"],
  ["safari", "26.0", "compatible"],
  ["chrome", "124.0", "unsupported"],
  ["chrome", "125.0", "compatible"],
  ["edge", "124", "unsupported"],
  ["edge", "156.0", "compatible"],
  ["firefox", "146.0", "unsupported"],
  ["firefox", "147.0", "compatible"],
  ["ie", "11.0", "unsupported"],
  ["chrome", "", "unknown"],
  ["firefox", "future", "unknown"],
  ["safari", "26-preview", "unknown"],
])(
  "estimates %s %s from required features, without treating unknown versions as unsupported",
  (family, version, expected) => {
    expect(estimate(family, version)).toBe(expected);
  },
);
