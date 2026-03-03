import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_DOWNLOAD_DIR, DEFAULT_UPLOAD_DIR, resolveStrictExistingPathsWithinRoot, } from "./paths.js";
import { ensurePageState, getPageForTargetId, refLocator, restoreRoleRefsForTarget, } from "./pw-session.js";
import { bumpDialogArmId, bumpDownloadArmId, bumpUploadArmId, normalizeTimeoutMs, requireRef, toAIFriendlyError, } from "./pw-tools-core.shared.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";
function buildTempDownloadPath(fileName) {
    const id = crypto.randomUUID();
    const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
    return path.join(resolvePreferredOpenClawTmpDir(), "downloads", `${id}-${safeName}`);
}
function createPageDownloadWaiter(page, timeoutMs) {
    let done = false;
    let timer;
    let handler;
    const cleanup = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = undefined;
        if (handler) {
            page.off("download", handler);
            handler = undefined;
        }
    };
    const promise = new Promise((resolve, reject) => {
        handler = (download) => {
            if (done) {
                return;
            }
            done = true;
            cleanup();
            resolve(download);
        };
        page.on("download", handler);
        timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            cleanup();
            reject(new Error("Timeout waiting for download"));
        }, timeoutMs);
    });
    return {
        promise,
        cancel: () => {
            if (done) {
                return;
            }
            done = true;
            cleanup();
        },
    };
}
async function saveDownloadPayload(download, outPath) {
    const suggested = download.suggestedFilename?.() || "download.bin";
    const requestedPath = outPath?.trim();
    const resolvedOutPath = path.resolve(requestedPath || buildTempDownloadPath(suggested));
    await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });
    if (!requestedPath) {
        await download.saveAs?.(resolvedOutPath);
    }
    else {
        await writeViaSiblingTempPath({
            rootDir: DEFAULT_DOWNLOAD_DIR,
            targetPath: resolvedOutPath,
            writeTemp: async (tempPath) => {
                await download.saveAs?.(tempPath);
            },
        });
    }
    return {
        url: download.url?.() || "",
        suggestedFilename: suggested,
        path: resolvedOutPath,
    };
}
async function awaitDownloadPayload(params) {
    try {
        const download = (await params.waiter.promise);
        if (params.state.armIdDownload !== params.armId) {
            throw new Error("Download was superseded by another waiter");
        }
        return await saveDownloadPayload(download, params.outPath ?? "");
    }
    catch (err) {
        params.waiter.cancel();
        throw err;
    }
}
export async function armFileUploadViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    const state = ensurePageState(page);
    const timeout = Math.max(500, Math.min(120000, opts.timeoutMs ?? 120000));
    state.armIdUpload = bumpUploadArmId();
    const armId = state.armIdUpload;
    void page
        .waitForEvent("filechooser", { timeout })
        .then(async (fileChooser) => {
        if (state.armIdUpload !== armId) {
            return;
        }
        if (!opts.paths?.length) {
            // Playwright removed `FileChooser.cancel()`; best-effort close the chooser instead.
            try {
                await page.keyboard.press("Escape");
            }
            catch {
                // Best-effort.
            }
            return;
        }
        const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: opts.paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
        });
        if (!uploadPathsResult.ok) {
            try {
                await page.keyboard.press("Escape");
            }
            catch {
                // Best-effort.
            }
            return;
        }
        await fileChooser.setFiles(uploadPathsResult.paths);
        try {
            const input = typeof fileChooser.element === "function"
                ? await Promise.resolve(fileChooser.element())
                : null;
            if (input) {
                await input.evaluate((el) => {
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                });
            }
        }
        catch {
            // Best-effort for sites that don't react to setFiles alone.
        }
    })
        .catch(() => {
        // Ignore timeouts; the chooser may never appear.
    });
}
export async function armDialogViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    const state = ensurePageState(page);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
    state.armIdDialog = bumpDialogArmId();
    const armId = state.armIdDialog;
    void page
        .waitForEvent("dialog", { timeout })
        .then(async (dialog) => {
        if (state.armIdDialog !== armId) {
            return;
        }
        if (opts.accept) {
            await dialog.accept(opts.promptText);
        }
        else {
            await dialog.dismiss();
        }
    })
        .catch(() => {
        // Ignore timeouts; the dialog may never appear.
    });
}
export async function waitForDownloadViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    const state = ensurePageState(page);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
    state.armIdDownload = bumpDownloadArmId();
    const armId = state.armIdDownload;
    const waiter = createPageDownloadWaiter(page, timeout);
    return await awaitDownloadPayload({ waiter, state, armId, outPath: opts.path });
}
export async function downloadViaPlaywright(opts) {
    const page = await getPageForTargetId(opts);
    const state = ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
    const ref = requireRef(opts.ref);
    const outPath = String(opts.path ?? "").trim();
    if (!outPath) {
        throw new Error("path is required");
    }
    state.armIdDownload = bumpDownloadArmId();
    const armId = state.armIdDownload;
    const waiter = createPageDownloadWaiter(page, timeout);
    try {
        const locator = refLocator(page, ref);
        try {
            await locator.click({ timeout });
        }
        catch (err) {
            throw toAIFriendlyError(err, ref);
        }
        return await awaitDownloadPayload({ waiter, state, armId, outPath });
    }
    catch (err) {
        waiter.cancel();
        throw err;
    }
}
