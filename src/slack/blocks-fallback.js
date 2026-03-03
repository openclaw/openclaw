function cleanCandidate(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : undefined;
}
function readSectionText(block) {
    return cleanCandidate(block.text?.text);
}
function readHeaderText(block) {
    return cleanCandidate(block.text?.text);
}
function readImageText(block) {
    return cleanCandidate(block.alt_text) ?? cleanCandidate(block.title?.text);
}
function readVideoText(block) {
    return cleanCandidate(block.title?.text) ?? cleanCandidate(block.alt_text);
}
function readContextText(block) {
    if (!Array.isArray(block.elements)) {
        return undefined;
    }
    const textParts = block.elements
        .map((element) => cleanCandidate(element.text))
        .filter((value) => Boolean(value));
    return textParts.length > 0 ? textParts.join(" ") : undefined;
}
export function buildSlackBlocksFallbackText(blocks) {
    for (const raw of blocks) {
        const block = raw;
        switch (block.type) {
            case "header": {
                const text = readHeaderText(block);
                if (text) {
                    return text;
                }
                break;
            }
            case "section": {
                const text = readSectionText(block);
                if (text) {
                    return text;
                }
                break;
            }
            case "image": {
                const text = readImageText(block);
                if (text) {
                    return text;
                }
                return "Shared an image";
            }
            case "video": {
                const text = readVideoText(block);
                if (text) {
                    return text;
                }
                return "Shared a video";
            }
            case "file": {
                return "Shared a file";
            }
            case "context": {
                const text = readContextText(block);
                if (text) {
                    return text;
                }
                break;
            }
            default:
                break;
        }
    }
    return "Shared a Block Kit message";
}
