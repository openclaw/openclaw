// Adopt exited tooling descendants and keep them unreaped until the command settles.
export const exitedDescendantReaper = `
import ctypes, os, subprocess, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
try:
    result = subprocess.run(sys.argv[1:])
finally:
    reaped = 0
    while True:
        try:
            pid, code = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0 or code != 0:
            raise RuntimeError("tool descendant did not exit successfully")
        reaped += 1
    print("successfully reaped:", reaped)
    if reaped == 0:
        raise RuntimeError("fixture did not retain an exited descendant")
sys.exit(result.returncode)
`;
