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
  const on = locked || selectedDaybreak !== undefined;
  const remap = on && program !== selected ? program : undefined;
  return {
    program,
    locked,
    on,
    checked: on && remap === undefined,
    visible: on || program !== undefined,
    remap,
  };
}

/** A model switch keeps Daybreak on: store the destination's program unless it is already stored. */
export function resolveDaybreakModelSwitch(
  programs: readonly CyberAccessProgram[],
  current: CyberAccessProgram | undefined,
  stored: CyberAccessProgram | undefined,
) {
  const { on, program } = resolveDaybreakAccessProgram(programs, current);
  return on && program !== stored ? program : undefined;
}
