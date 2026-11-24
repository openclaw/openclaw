import { expect, it } from "vitest";
import type { CyberAccessProgram } from "../../api/types.ts";
import { resolveDaybreakAccessProgram } from "./daybreak-access-program.ts";

const mainline = ["standard", "daybreak_blue"] as const;
const cyber = ["daybreak_red"] as const;

it.each<{
  programs?: readonly CyberAccessProgram[];
  selected?: CyberAccessProgram;
  program?: CyberAccessProgram;
  remap?: CyberAccessProgram;
  locked: boolean;
  on: boolean;
  checked: boolean;
  visible: boolean;
}>([
  {
    programs: mainline,
    selected: "standard",
    program: "daybreak_blue",
    locked: false,
    on: false,
    checked: false,
    visible: true,
  },
  {
    programs: mainline,
    selected: "daybreak_blue",
    program: "daybreak_blue",
    locked: false,
    on: true,
    checked: true,
    visible: true,
  },
  {
    programs: cyber,
    selected: "daybreak_red",
    program: "daybreak_red",
    locked: true,
    on: true,
    checked: true,
    visible: true,
  },
  {
    programs: cyber,
    selected: "daybreak_blue",
    program: "daybreak_red",
    remap: "daybreak_red",
    locked: true,
    on: true,
    checked: false,
    visible: true,
  },
  {
    programs: cyber,
    selected: "standard",
    program: "daybreak_red",
    remap: "daybreak_red",
    locked: true,
    on: true,
    checked: false,
    visible: true,
  },
  {
    programs: cyber,
    program: "daybreak_red",
    remap: "daybreak_red",
    locked: true,
    on: true,
    checked: false,
    visible: true,
  },
  {
    programs: mainline,
    selected: "daybreak_red",
    program: "daybreak_blue",
    remap: "daybreak_blue",
    locked: false,
    on: true,
    checked: false,
    visible: true,
  },
  {
    programs: ["standard", "daybreak_blue", "daybreak_red"],
    selected: "daybreak_red",
    program: "daybreak_red",
    locked: false,
    on: true,
    checked: true,
    visible: true,
  },
  { selected: "daybreak_blue", locked: false, on: true, checked: true, visible: true },
  { locked: false, on: false, checked: false, visible: false },
  {
    programs: ["standard"],
    selected: "daybreak_blue",
    locked: false,
    on: true,
    checked: true,
    visible: true,
  },
  { programs: [], selected: "standard", locked: false, on: false, checked: false, visible: false },
])("resolves Daybreak with $programs and $selected", ({ programs, selected, ...state }) => {
  expect(resolveDaybreakAccessProgram(programs, selected)).toEqual(state);
});
