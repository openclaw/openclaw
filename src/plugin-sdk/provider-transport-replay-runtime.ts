// Private helper surface for bundled provider transports.
// Keep provider replay extraction out of the public plugin SDK contract until
// maintainers explicitly accept it as third-party plugin API.

export {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
} from "../llm/providers/tool-result-text.js";
