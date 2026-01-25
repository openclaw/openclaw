import os
import socket

host = os.environ.get("HOST", "localhost")
port = int(os.environ.get("PORT", "4173"))


def can_bind(p: int) -> bool:
    try:
        infos = socket.getaddrinfo(host, p, 0, socket.SOCK_STREAM)
    except OSError:
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (host, p))]

    for family, socktype, proto, _, sockaddr in infos:
        s = socket.socket(family, socktype, proto)
        try:
            s.bind(sockaddr)
        except OSError:
            s.close()
            return False
        s.close()
    return True


selected = port if can_bind(port) else 0
infos = socket.getaddrinfo(host, selected, 0, socket.SOCK_STREAM)
family, socktype, proto, _, sockaddr = infos[0]
s = socket.socket(family, socktype, proto)
s.bind(sockaddr)
print(s.getsockname()[1])
s.close()

