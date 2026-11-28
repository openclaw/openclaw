const START_BOUNDARY_CHARACTER = "[\\s(\\[{<\"'`]";
const startBoundaryCharacter = new RegExp(`^${START_BOUNDARY_CHARACTER}$`, "u");
export const MARKDOWN_LINK_START_BOUNDARY_SOURCE = `(?:^|(?<=${START_BOUNDARY_CHARACTER}))`;

export function hasMarkdownLinkBoundaries(value: string, start: number, end: number): boolean {
  const before = value[start - 1];
  const after = value[end];
  return (
    (before === undefined || startBoundaryCharacter.test(before)) &&
    (after === undefined || /\s/.test(after) || ".,;:!?)]}>\"'".includes(after))
  );
}
