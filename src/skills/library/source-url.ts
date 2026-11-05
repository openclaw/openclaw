import { SkillLibraryError } from "../skill-library-error.js";

/** Known web URL shapes are conveniences; unknown forges can supply an archive URL and path. */
export function resolveSkillLibraryUrl(source: { url: string; path?: string; ref?: string }) {
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "Use an HTTPS SKILL.md or archive URL without embedded credentials.",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const gitlab = parts.findIndex(
    (part, index) => part === "-" && ["tree", "blob"].includes(parts[index + 1] ?? ""),
  );
  const gitea = parts[2] === "src" && ["branch", "tag", "commit"].includes(parts[3] ?? "");
  const marker =
    gitlab >= 1 && ["tree", "blob"].includes(parts[gitlab + 1] ?? "")
      ? gitlab + 1
      : gitea
        ? 3
        : ["tree", "blob"].includes(parts[2] ?? "")
          ? 2
          : -1;
  let selectedPath = source.path ?? "";
  let ref = source.ref;
  if (marker >= 0 && parts[marker + 1]) {
    const originalRef = decodeURIComponent(parts[marker + 1]!);
    ref ??= originalRef;
    const rest = parts
      .slice(marker + 1)
      .map(decodeURIComponent)
      .join("/");
    const folder = rest.startsWith(ref + "/")
      ? rest.slice(ref.length + 1)
      : parts
          .slice(marker + 2)
          .map(decodeURIComponent)
          .join("/");
    const prefix = parts.slice(0, gitlab >= 1 ? gitlab : 2).join("/");
    const file = parts[marker] === "blob" || (gitea && folder.split("/").at(-1) === "SKILL.md");
    if (file) {
      url.pathname =
        gitlab >= 1
          ? "/" +
            prefix +
            "/-/raw/" +
            encodeURIComponent(ref) +
            "/" +
            folder.split("/").map(encodeURIComponent).join("/")
          : gitea
            ? "/" +
              prefix +
              "/raw/" +
              parts[3] +
              "/" +
              encodeURIComponent(ref) +
              "/" +
              folder.split("/").map(encodeURIComponent).join("/")
            : "/" +
              prefix +
              "/raw/" +
              encodeURIComponent(ref) +
              "/" +
              folder.split("/").map(encodeURIComponent).join("/");
    } else {
      selectedPath ||= folder;
      url.pathname =
        gitlab >= 1
          ? "/" +
            prefix +
            "/-/archive/" +
            encodeURIComponent(ref) +
            "/" +
            parts[gitlab - 1] +
            "-" +
            encodeURIComponent(ref) +
            ".zip"
          : "/" + prefix + "/archive/" + encodeURIComponent(ref) + ".zip";
    }
    url.search = "";
  }
  selectedPath = selectedPath.replace(/\/+$/u, "");
  return {
    url: url.href,
    path: selectedPath === "." ? "" : selectedPath,
    file: url.pathname.endsWith("/SKILL.md") && !selectedPath,
  };
}
