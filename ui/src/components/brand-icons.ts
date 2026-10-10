import { githubMark } from "./github-mark.ts";
import { brandIconData } from "./icon-data-brand.ts";
import { renderIconData } from "./icon-lit.ts";

export const brandIcons = {
  github: githubMark,
  reddit: renderIconData(brandIconData.reddit),
  discord: renderIconData(brandIconData.discord),
  x: renderIconData(brandIconData.x),
} as const;
