import type { CyberAccessProgram } from "../../api/types.ts";

export function resolveDaybreakAccessProgram(
  programs: readonly CyberAccessProgram[] | undefined,
  selected: CyberAccessProgram | undefined,
) {
  const selectedDaybreak = selected === "standard" ? undefined : selected;
  const program =
    selectedDaybreak && programs?.includes(selectedDaybreak)
      ? selectedDaybreak
      : programs?.find((value) => value !== "standard");
  const locked = program !== undefined && programs?.includes("standard") === false;
  const visible = program !== undefined;
  const on = visible && (locked || selectedDaybreak !== undefined);
  const remap = on && program !== selected ? program : undefined;
  return {
    program,
    locked,
    on,
    checked: on && remap === undefined,
    visible,
    remap,
  };
}

/** Keep Daybreak on across supported models and clear it when the destination has none. */
export function resolveDaybreakModelSwitch(
  programs: readonly CyberAccessProgram[] | undefined,
  current: CyberAccessProgram | undefined,
  stored: CyberAccessProgram | undefined,
) {
  const { on, program } = resolveDaybreakAccessProgram(programs, current);
  const next = on ? program : stored === "standard" ? stored : undefined;
  return next === stored ? undefined : (next ?? null);
}
