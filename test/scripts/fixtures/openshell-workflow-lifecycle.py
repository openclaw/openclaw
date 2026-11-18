"""Synthetic commands and a Linux subreaper for the unchanged workflow shell."""
import ctypes
import json
import os
import pathlib
import selectors
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys


def connect():
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    connection.connect("\0" + os.environ["OPENSHELL_FIXTURE_SOCKET"])
    return connection


def request(connection, value):
    connection.sendall(json.dumps(value).encode())
    response = connection.recv(65536)
    if not response:
        raise RuntimeError("fixture controller closed before acknowledging the command")
    return json.loads(response)


def hold(role, ready_fd=None):
    with connect() as connection:
        def terminate(_signum, _frame):
            connection.sendall(json.dumps({"event": "term", "role": role}).encode())
            os._exit(0)

        signal.signal(signal.SIGTERM, terminate)
        request(connection, {"event": "hold", "role": role})
        connection.sendall(json.dumps({"event": "ready", "role": role}).encode())
        if ready_fd is not None:
            os.write(ready_fd, b"1")
            os.close(ready_fd)
        while True:
            signal.pause()


def actor(command, args):
    if command == "openshell-gateway" and args[0] != "generate-certs":
        hold("gateway")
    with connect() as connection:
        answer = request(connection, {
            "event": "call", "command": command, "args": args,
            "fixtureRoot": str(pathlib.Path(os.environ["XDG_CONFIG_HOME"]).parent),
        })
    if answer.get("action") == "descendant":
        read_fd, write_fd = os.pipe()
        if os.fork() == 0:
            os.close(read_fd)
            hold("descendant", write_fd)
        os.close(write_fd)
        if os.read(read_fd, 1) != b"1":
            raise RuntimeError("descendant exited before readiness")
        os.close(read_fd)
        return 42
    if answer.get("action") == "hold":
        hold("suite")
    sys.stdout.write(answer.get("stdout", ""))
    return answer.get("code", 0)


def supervise(root, script, scenario):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    namespace = "openshell-e2e-123-2"
    report = {"calls": [], "terminated": [], "emergency": [], "reapedDescendants": 0}
    containers = {
        "aa11": {"openshell.ai/managed-by": "openshell", "openshell.ai/sandbox-namespace": namespace},
        "bb22": {"openshell.ai/managed-by": "openshell", "openshell.ai/sandbox-namespace": namespace},
        "cc33": {"openshell.ai/managed-by": "openshell", "openshell.ai/sandbox-namespace": namespace + "-other"},
        "dd44": {"openshell.ai/managed-by": "unrelated", "openshell.ai/sandbox-namespace": namespace},
        "ee55": {"openclaw.ai/openshell-e2e-gateway": namespace},
        "ff66": {"openclaw.ai/openshell-e2e-gateway": namespace + "-other"},
    }
    networks = {namespace, namespace + "-other", "another-network"}
    bin_dir = root / "bin"
    bin_dir.mkdir()
    runner_temp = root / "runner"
    runner_temp.mkdir()
    for command in ("openshell-gateway", "openshell", "fixture-suite", "docker", "sleep"):
        executable = bin_dir / command
        executable.write_text("#!/bin/sh\nexec " + " ".join(map(shlex.quote, (
            sys.executable, "-I", "-S", str(pathlib.Path(__file__).resolve()), "actor", command,
        ))) + ' "$@"\n')
        executable.chmod(0o755)
    address = "openshell-lifecycle-" + str(os.getpid())
    selector = selectors.DefaultSelector()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    listener.bind("\0" + address)
    listener.listen()
    selector.register(listener, selectors.EVENT_READ, "accept")
    wake_read, wake_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    signal.set_wakeup_fd(wake_write)
    interrupted = False

    def interrupt(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGCHLD, lambda *_: None)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    selector.register(wake_read, selectors.EVENT_READ, "signal")
    shell = subprocess.Popen(["bash", "--noprofile", "--norc", str(script)], env={
        "PATH": str(bin_dir) + ":" + os.environ["PATH"], "HOME": str(root),
        "RUNNER_TEMP": str(runner_temp), "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
        "OPENSHELL_FIXTURE_SOCKET": address,
    })
    shell_fd = os.pidfd_open(shell.pid)
    owned = {shell.pid: {"fd": shell_fd, "role": "shell", "exited": False, "reaped": False}}
    selector.register(shell_fd, selectors.EVENT_READ, ("exit", shell.pid))
    connections = set()
    pending = []
    gateway_ready = False
    whoami_count = 0

    def reply(connection, value=None):
        connection.sendall(json.dumps(value or {}).encode())

    def stop_owned():
        for entry in owned.values():
            if entry.get("emergencySent") or select.select([entry["fd"]], [], [], 0)[0]:
                continue
            try:
                signal.pidfd_send_signal(entry["fd"], signal.SIGKILL)
                entry["emergencySent"] = True
                report["emergency"].append(entry["role"])
            except ProcessLookupError:
                pass

    def docker(args):
        if args[:2] == ["ps", "-aq"]:
            if scenario == "docker-query-failure":
                return {"code": 17}
            filters = args[2:]
            assert len(filters) % 2 == 0
            labels = {}
            for flag, value in zip(filters[::2], filters[1::2]):
                assert flag == "--filter" and value.startswith("label=")
                key, value = value[6:].split("=", 1)
                labels[key] = value
            selected = [key for key, actual in containers.items()
                        if all(actual.get(label) == value for label, value in labels.items())]
            return {"stdout": "\n".join(selected) + "\n"}
        if args[:3] == ["rm", "-f", "--"]:
            for key in args[3:]:
                del containers[key]
            return {}
        if args == ["network", "ls", "--format", "{{.Name}}"]:
            return {"stdout": "\n".join(sorted(networks)) + "\n"}
        if args[:2] == ["network", "rm"] and len(args) == 3:
            if scenario == "docker-mutation-failure":
                return {"code": 19}
            networks.remove(args[2])
            return {}
        raise AssertionError("unexpected Docker command: " + repr(args))

    try:
        while True:
            for key, _ in selector.select():
                if key.data == "accept":
                    connection, _ = listener.accept()
                    connections.add(connection)
                    selector.register(connection, selectors.EVENT_READ, "message")
                elif key.data == "signal":
                    os.read(wake_read, 65536)
                elif isinstance(key.data, tuple):
                    entry = owned[key.data[1]]
                    entry["exited"] = True
                    selector.unregister(key.fd)
                else:
                    connection = key.fileobj
                    packet = connection.recv(65536)
                    if not packet:
                        selector.unregister(connection)
                        connections.remove(connection)
                        connection.close()
                        continue
                    message = json.loads(packet)
                    event = message["event"]
                    if event == "hold":
                        # The actor waits for this acknowledgement, pinning its lifetime.
                        pid, _, _ = struct.unpack("3i", connection.getsockopt(
                            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
                        descriptor = os.pidfd_open(pid)
                        owned[pid] = {"fd": descriptor, "role": message["role"],
                                      "exited": False, "reaped": False}
                        selector.register(descriptor, selectors.EVENT_READ, ("exit", pid))
                        reply(connection)
                    elif event == "ready":
                        if message["role"] == "gateway":
                            gateway_ready = True
                        elif message["role"] == "suite" and scenario == "cancel":
                            signal.pidfd_send_signal(shell_fd, signal.SIGTERM)
                    elif event == "term":
                        report["terminated"].append(message["role"])
                    else:
                        assert event == "call"
                        command, args = message["command"], message["args"]
                        report["fixtureRoot"] = message["fixtureRoot"]
                        report["calls"].append({"command": command, "args": args})
                        if command == "docker":
                            reply(connection, docker(args))
                        elif command == "sleep":
                            assert args in (["0.2"], ["1"])
                            pending.append((connection, "cleanup" if args == ["0.2"] else "ready"))
                        elif command == "openshell-gateway":
                            assert args[0] == "generate-certs"
                            pathlib.Path(message["fixtureRoot"], "pki").mkdir()
                            reply(connection)
                        elif command == "openshell" and args[:2] == ["gateway", "add"]:
                            pending.append((connection, "gateway"))
                        elif command == "openshell" and args[-1] == "whoami":
                            whoami_count += 1
                            failed = scenario in ("leader-failure", "docker-mutation-failure")
                            reply(connection, {"action": "descendant"} if failed and whoami_count == 1 else {})
                        elif command == "fixture-suite":
                            reply(connection, {"action": "hold"} if scenario == "cancel" else {})
                        else:
                            assert command == "openshell" and args[-2:] == ["sandbox", "list"]
                            reply(connection)
            no_children = False
            # Drain SIGCHLD notifications here; Popen.wait must not compete for children.
            while True:
                try:
                    pid, code = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    no_children = True
                    break
                if pid == 0:
                    break
                if pid == shell.pid:
                    shell.returncode = os.waitstatus_to_exitcode(code)
                    report["shellStatus"] = shell.returncode
                if pid in owned:
                    owned[pid]["reaped"] = True
                    if owned[pid]["role"] == "descendant":
                        report["reapedDescendants"] += 1
            if interrupted or (shell.returncode is not None and not no_children):
                stop_owned()
            for connection, gate in pending[:]:
                # Replace elapsed cleanup grace with observed exit and adoption receipts.
                settled = all(entry["exited"] and (entry["role"] != "descendant" or entry["reaped"])
                              for entry in owned.values() if entry["role"] != "shell")
                if gate == "ready" or (gate == "gateway" and gateway_ready) or (gate == "cleanup" and settled):
                    reply(connection)
                    pending.remove((connection, gate))
            if shell.returncode is not None and no_children and not connections:
                break
        assert not interrupted, "fixture controller was interrupted"
    finally:
        stop_owned()
        for connection in connections:
            connection.close()
        listener.close()
        # Closing the protocol releases unregistered short-lived commands too.
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
        for entry in owned.values():
            os.close(entry["fd"])
        signal.set_wakeup_fd(-1)
        os.close(wake_read)
        os.close(wake_write)
        selector.close()
    report["containers"] = sorted(containers)
    report["networks"] = sorted(networks)
    (root / "lifecycle.json").write_text(json.dumps(report))


if sys.argv[1] == "actor":
    sys.exit(actor(sys.argv[2], sys.argv[3:]))
supervise(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3])
