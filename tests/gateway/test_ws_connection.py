"""Tests for WebSocket connection management."""

import pytest
from unittest.mock import AsyncMock

from openclaw_py.gateway.ws_connection import (
    WebSocketConnectionManager,
    authenticate_connection,
)
from openclaw_py.gateway.ws_types import ConnectionState, WebSocketClient
from openclaw_py.config import GatewayConfig


@pytest.fixture
def manager():
    """Create a connection manager."""
    return WebSocketConnectionManager()


@pytest.fixture
def mock_client():
    """Create a mock WebSocket client."""
    return WebSocketClient(
        conn_id="test-conn",
        client_id="test-client",
        connected_at=1700000000,
    )


@pytest.fixture
def mock_connection(mock_client):
    """Create a mock connection state."""
    return ConnectionState(
        websocket=AsyncMock(),
        client=mock_client,
    )


def test_manager_initialization(manager):
    """Test connection manager initialization."""
    assert isinstance(manager.connections, set)
    assert len(manager.connections) == 0
    assert isinstance(manager.clients_by_id, dict)
    assert len(manager.clients_by_id) == 0


def test_add_connection(manager, mock_connection):
    """Test adding a connection."""
    manager.add_connection(mock_connection)

    assert len(manager.connections) == 1
    assert mock_connection in manager.connections
    assert manager.clients_by_id["test-client"] == mock_connection


def test_add_connection_without_client_id(manager):
    """Test adding connection without client ID."""
    client = WebSocketClient(
        conn_id="anon",
        client_id=None,
        connected_at=1700000000,
    )
    conn = ConnectionState(websocket=AsyncMock(), client=client)

    manager.add_connection(conn)

    assert len(manager.connections) == 1
    assert len(manager.clients_by_id) == 0  # Not indexed by client ID


def test_remove_connection(manager, mock_connection):
    """Test removing a connection."""
    manager.add_connection(mock_connection)
    assert len(manager.connections) == 1

    manager.remove_connection(mock_connection)

    assert len(manager.connections) == 0
    assert "test-client" not in manager.clients_by_id


def test_remove_nonexistent_connection(manager, mock_connection):
    """Test removing connection that doesn't exist."""
    # Should not raise error
    manager.remove_connection(mock_connection)
    assert len(manager.connections) == 0


def test_get_connection_count(manager, mock_connection):
    """Test getting connection count."""
    assert manager.get_connection_count() == 0

    manager.add_connection(mock_connection)
    assert manager.get_connection_count() == 1

    client2 = WebSocketClient(
        conn_id="conn-2",
        client_id="client-2",
        connected_at=1700000001,
    )
    conn2 = ConnectionState(websocket=AsyncMock(), client=client2)
    manager.add_connection(conn2)

    assert manager.get_connection_count() == 2


def test_get_client_by_id(manager, mock_connection):
    """Test getting client by ID."""
    manager.add_connection(mock_connection)

    found = manager.get_client_by_id("test-client")
    assert found == mock_connection

    not_found = manager.get_client_by_id("nonexistent")
    assert not_found is None


def test_multiple_connections_same_client_id(manager):
    """Test handling multiple connections with same client ID."""
    # First connection
    client1 = WebSocketClient(
        conn_id="conn-1",
        client_id="same-client",
        connected_at=1700000000,
    )
    conn1 = ConnectionState(websocket=AsyncMock(), client=client1)

    # Second connection with same client_id
    client2 = WebSocketClient(
        conn_id="conn-2",
        client_id="same-client",
        connected_at=1700000001,
    )
    conn2 = ConnectionState(websocket=AsyncMock(), client=client2)

    manager.add_connection(conn1)
    manager.add_connection(conn2)

    # Latest connection should be in index
    assert manager.get_client_by_id("same-client") == conn2
    # But both should be in connections set
    assert len(manager.connections) == 2


def test_authenticate_connection_local():
    """Test authentication for local connection."""
    config = GatewayConfig(enabled=True)

    authenticated, source = authenticate_connection("127.0.0.1", config)

    assert authenticated is True
    assert source == "local-direct"


def test_authenticate_connection_localhost_ipv6():
    """Test authentication for localhost IPv6."""
    config = GatewayConfig(enabled=True)

    authenticated, source = authenticate_connection("::1", config)

    assert authenticated is True
    assert source == "local-direct"


def test_authenticate_connection_remote():
    """Test authentication for remote connection (not yet implemented)."""
    config = GatewayConfig(enabled=True)

    authenticated, source = authenticate_connection("192.168.1.100", config)

    # Remote connections not yet supported
    assert authenticated is False
    assert source is None


def test_authenticate_connection_no_ip():
    """Test authentication with no client IP (e.g., TestClient)."""
    config = GatewayConfig(enabled=True)

    authenticated, source = authenticate_connection(None, config)

    # None IP is allowed for test clients
    assert authenticated is True
    assert source == "local-direct"


def test_manager_concurrent_add_remove(manager):
    """Test adding and removing connections concurrently."""
    clients = []
    for i in range(10):
        client = WebSocketClient(
            conn_id=f"conn-{i}",
            client_id=f"client-{i}",
            connected_at=1700000000 + i,
        )
        conn = ConnectionState(websocket=AsyncMock(), client=client)
        clients.append(conn)
        manager.add_connection(conn)

    assert manager.get_connection_count() == 10

    # Remove half
    for conn in clients[:5]:
        manager.remove_connection(conn)

    assert manager.get_connection_count() == 5
    assert len(manager.clients_by_id) == 5
