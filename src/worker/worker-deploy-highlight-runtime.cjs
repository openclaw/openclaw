// CommonJS keeps language registration lazy inside the sealed worker bundle.
module.exports = function loadHighlightJsRuntime() {
  return require("highlight.js");
};
