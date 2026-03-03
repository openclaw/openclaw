function isZero(value) {
    return value === 0 || value === 0n;
}
export function sameFileIdentity(left, right, platform = process.platform) {
    if (left.ino !== right.ino) {
        return false;
    }
    // On Windows, path-based stat calls can report dev=0 while fd-based stat
    // reports a real volume serial; treat either-side dev=0 as "unknown device".
    if (left.dev === right.dev) {
        return true;
    }
    return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
