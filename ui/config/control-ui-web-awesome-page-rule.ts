import type { Plugin } from "postcss";

// Web Awesome's default theme resets <html>/<body> for <wa-page> layouts. The Control UI never
// renders <wa-page>, so the rule never matches, yet its :has() subjects make Blink restyle html
// (with every root token) and body on each DOM insertion or removal. Removing it keeps computed
// styles identical.
const webAwesomePageReset = ":is(html,body):has(wa-page)";

export function controlUiWebAwesomePageRulePlugin(): Plugin {
  return {
    postcssPlugin: "control-ui-web-awesome-page-rule",
    Rule(rule) {
      if (
        rule.selector.includes("wa-page") &&
        rule.selector.replace(/\s+/gu, "") === webAwesomePageReset
      ) {
        rule.remove();
      }
    },
  };
}
