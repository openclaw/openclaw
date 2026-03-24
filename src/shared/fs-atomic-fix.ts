import fs from "fs";

/**
 * Handles EPERM issues during chmod on Windows-mounted Docker volumes.
 * Addresses #53947.
 */
export function writeTextFileAtomicSync(pathname: string, value: string, mode: number = 0o600) {
    const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, value, "utf8");
    
    try {
        // This fails on Windows-mounted volumes in Docker
        fs.chmodSync(tempPath, mode);
    } catch (e) {
        // Silently continue if chmod fails (EPERM expected on NTFS/CIFS mounts)
    }
    
    fs.renameSync(tempPath, pathname);
}
