export function stripAssistantInternalScaffolding(value) {
  const valueText = value == null ? "" : String(value);
  let output = "";
  let index = 0;
  let inCodeBlock = false;
  let trimLeadingWhitespace = false;

  const openTags = {
    "<think>": { close: "</think>", action: "strip", dropToEndOnMissingClose: false },
    "<thinking>": { close: "</thinking>", action: "strip", dropToEndOnMissingClose: false },
    "<final>": { close: "</final>", action: "passthrough", dropToEndOnMissingClose: false },
    "<relevant-memories>": {
      close: "</relevant-memories>",
      action: "strip",
      dropToEndOnMissingClose: true,
    },
  };
  const orphanCloseTags = ["</think>", "</thinking>", "</final>", "</relevant-memories>"];

  while (index < valueText.length) {
    const char = valueText[index];

    if (valueText.startsWith("```", index)) {
      const fenceEnd = index + 3;
      inCodeBlock = !inCodeBlock;
      output += valueText.slice(index, fenceEnd);
      index = fenceEnd;
      continue;
    }

    if (inCodeBlock) {
      output += char;
      index += 1;
      continue;
    }

    if (trimLeadingWhitespace && char.trim() === "") {
      index += 1;
      continue;
    }
    if (trimLeadingWhitespace) {
      trimLeadingWhitespace = false;
    }

    const openMatch = Object.keys(openTags).find((openTag) => valueText.startsWith(openTag, index));
    if (openMatch) {
      const tagRule = openTags[openMatch];
      const closeIndex = valueText.indexOf(tagRule.close, index + openMatch.length);
      if (closeIndex < 0) {
        if (tagRule.action === "passthrough") {
          output += openMatch;
          index += openMatch.length;
          continue;
        }
        if (tagRule.dropToEndOnMissingClose) {
          return output;
        }
        index += openMatch.length;
        if (valueText[index] === "\n") {
          index += 1;
        }
        continue;
      }
      if (tagRule.action === "strip") {
        index = closeIndex + tagRule.close.length;
        trimLeadingWhitespace = true;
      } else {
        const innerStart = index + openMatch.length;
        const innerContent = valueText.slice(innerStart, closeIndex).replace(/^\n+/, "");
        output += innerContent;
        index = closeIndex + tagRule.close.length;
      }
      continue;
    }

    const closeMatch = orphanCloseTags.find((closeTag) => valueText.startsWith(closeTag, index));
    if (closeMatch) {
      const remainder = valueText.slice(index + closeMatch.length);
      if (remainder.trim().length > 0) {
        output = "";
        index += closeMatch.length;
        while (valueText[index] === " " || valueText[index] === "\t") {
          index += 1;
        }
      } else {
        index += closeMatch.length;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}
