# Runs in the original owner process; observations never authorize cleanup.
import ctypes as probe_ctypes
probe_kernel = probe_ctypes.WinDLL("kernel32", use_last_error=True)
probe_open = probe_kernel.OpenProcess
probe_open.argtypes, probe_open.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
probe_member = probe_kernel.IsProcessInJob
probe_member.argtypes, probe_member.restype = [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)], w.BOOL
probe_wait = probe_kernel.WaitForSingleObject
probe_wait.argtypes, probe_wait.restype = [w.HANDLE, w.DWORD], w.DWORD
probe_times = probe_kernel.GetProcessTimes
probe_times.argtypes, probe_times.restype = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4, w.BOOL
original_drain = drain

def drain(child, job):
    root = os.environ["OWNER_SETTLEMENT_ROOT"]
    held = []
    try:
        for name in (os.listdir(os.path.join(root, "pids")) if os.path.isdir(os.path.join(root, "pids")) else []):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(root, "pids", name)) as stream:
                record = json.load(stream)
            handle = probe_open(0x00100000 | 0x1000, False, record["pid"])
            if not handle:
                if c.get_last_error() == 87:
                    continue  # An already completed earlier invocation, not a current member.
                raise c.WinError(c.get_last_error())
            member = w.BOOL()
            if not probe_member(handle, job, c.byref(member)):
                close_handle(handle)
                raise c.WinError(c.get_last_error())
            if not member.value:
                close_handle(handle)
                continue
            held.append((handle, record))
            times = [w.FILETIME() for _ in range(4)]
            assert probe_times(handle, *(c.byref(value) for value in times))
            birth = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
            assert birth == record["creationTime"], (birth, record)
        original_drain(child, job)
        observations = [dict(pid=record["pid"], creationTime=record["creationTime"],
                             wait=int(probe_wait(handle, 0))) for handle, record in held]
        with open(os.path.join(root, "settlement.jsonl"), "a") as stream:
            stream.write(json.dumps(observations) + "\n")
        assert all(value["wait"] == 0 for value in observations), observations
    finally:
        for handle, record in held:
            close_handle(handle)
