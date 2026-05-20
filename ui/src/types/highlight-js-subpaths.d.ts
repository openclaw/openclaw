declare module "highlight.js/lib/core.js" {
  import hljs from "highlight.js/lib/core";

  export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
  import type { LanguageFn } from "highlight.js";

  const language: LanguageFn;
  export default language;
}
