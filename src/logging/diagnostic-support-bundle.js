import fs from "node:fs";
import path from "node:path";
export function supportBundleByteLength(content) {
    return Buffer.byteLength(content, "utf8");
}
export function jsonSupportBundleFile(pathName, value) {
    return {
        path: assertSafeBundleRelativePath(pathName),
        mediaType: "application/json",
        content: `${JSON.stringify(value, null, 2)}\n`,
    };
}
export function jsonlSupportBundleFile(pathName, lines) {
    return {
        path: assertSafeBundleRelativePath(pathName),
        mediaType: "application/x-ndjson",
        content: `${lines.join("\n")}\n`,
    };
}
export function textSupportBundleFile(pathName, content) {
    return {
        path: assertSafeBundleRelativePath(pathName),
        mediaType: "text/plain; charset=utf-8",
        content: content.endsWith("\n") ? content : `${content}\n`,
    };
}
export function supportBundleContents(files) {
    return files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        bytes: supportBundleByteLength(file.content),
    }));
}
export function assertSafeBundleRelativePath(pathName) {
    const normalized = pathName.replaceAll("\\", "/");
    if (!normalized ||
        normalized.startsWith("/") ||
        normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`Invalid bundle file path: ${pathName}`);
    }
    return normalized;
}
export function prepareSupportBundleDirectory(outputDir) {
    fs.mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputDir, { mode: 0o700 });
}
export function resolveSupportBundleFilePath(outputDir, pathName) {
    const safePath = assertSafeBundleRelativePath(pathName);
    const resolvedBase = path.resolve(outputDir);
    const resolvedFile = path.resolve(resolvedBase, safePath);
    const relative = path.relative(resolvedBase, resolvedFile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Bundle file path escaped output directory: ${pathName}`);
    }
    return resolvedFile;
}
export function writeSupportBundleFile(outputDir, file) {
    const filePath = resolveSupportBundleFilePath(outputDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
    });
}
export function copySupportBundleFile(params) {
    const outputPath = resolveSupportBundleFilePath(params.outputDir, params.path);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(params.sourceFile, outputPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(outputPath, 0o600);
    const stat = fs.statSync(outputPath);
    return {
        path: assertSafeBundleRelativePath(params.path),
        mediaType: "application/x-ndjson",
        bytes: stat.size,
    };
}
export function writeSupportBundleDirectory(params) {
    prepareSupportBundleDirectory(params.outputDir);
    for (const file of params.files) {
        writeSupportBundleFile(params.outputDir, file);
    }
    return supportBundleContents(params.files);
}
export async function writeSupportBundleZip(params) {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const file of params.files) {
        zip.file(assertSafeBundleRelativePath(file.path), file.content);
    }
    const buffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: params.compressionLevel ?? 6 },
    });
    fs.mkdirSync(path.dirname(params.outputPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(params.outputPath, buffer, { mode: 0o600 });
    return buffer.length;
}
