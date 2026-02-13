"""WebSocket integration tests."""

import json

import pytest
from fastapi.testclient import TestClient

from openclaw_py.config import GatewayConfig, OpenClawConfig
from openclaw_py.gateway.app import create_app
from openclaw_py.gateway.ws_server import get_connection_manager


@pytest.fixture
def test_config():
    """Create test configuration."""
    return OpenClawConfig(
        gateway=GatewayConfig(enabled=True),
    )


@pytest.fixture
def client(test_config):
    """Create test client."""
    app = create_app(test_config)
    return TestClient(app)


def test_websocket_connect_and_disconnect(client):
    """Test WebSocket connection and disconnection."""
    manager = get_connection_manager()
    initial_count = manager.get_connection_count()

    with client.websocket_connect("/ws") as websocket:
        # Send connect frame
        connect_frame = {
            "type": "request",
            "id": "connect",
            "method": "connect",
            "params": {
                "client_id": "test-client",
                "protocol_version": "1.0",
            },
        }
        websocket.send_text(json.dumps(connect_frame))

        # Receive connect response
        response = websocket.receive_text()
        data = json.loads(response)

        assert data["type"] == "response"
        assert data["id"] == "connect"
        assert "result" in data
        assert "conn_id" in data["result"]

    # After disconnect, connection count should return to initial
    assert manager.get_connection_count() == initial_count


def test_websocket_ping_pong(client):
    """Test WebSocket ping-pong."""
    with client.websocket_connect("/ws") as websocket:
        # Send connect frame
        connect_frame = {
            "type": "request",
            "id": "connect",
            "method": "connect",
            "params": {"client_id": "ping-test"},
        }
        websocket.send_text(json.dumps(connect_frame))

        # Receive connect response
        websocket.receive_text()

        # Send ping
        ping_frame = {
            "type": "request",
            "id": "ping-1",
            "method": "ping",
            "params": {},
        }
        websocket.send_text(json.dumps(ping_frame))

        # Receive pong
        response = websocket.receive_text()
        data = json.loads(response)

        assert data["type"] == "response"
        assert data["id"] == "ping-1"
        assert data["result"]["pong"] is True


def test_websocket_get_status(client):
    """Test WebSocket get_status method."""
    with client.websocket_connect("/ws") as websocket:
        # Connect
        connect_frame = {
            "type": "request",
            "id": "connect",
            "method": "connect",
            "params": {"client_id": "status-test"},
        }
        websocket.send_text(json.dumps(connect_frame))
        websocket.receive_text()

        # Get status
        status_frame = {
            "type": "request",
            "id": "status-1",
            "method": "get_status",
            "params": {},
        }
        websocket.send_text(json.dumps(status_frame))

        # Receive status
        response = websocket.receive_text()
        data = json.loads(response)

        assert data["type"] == "response"
        assert data["id"] == "status-1"
        assert "result" in data
        assert "conn_id" in data["result"]
        assert data["result"]["client_id"] == "status-test"
        assert data["result"]["authenticated"] is True
        assert data["result"]["total_connections"] >= 1


def test_websocket_unknown_method(client):
    """Test WebSocket with unknown method returns error."""
    with client.websocket_connect("/ws") as websocket:
        # Connect
        connect_frame = {
            "type": "request",
            "id": "connect",
            "method": "connect",
            "params": {},
        }
        websocket.send_text(json.dumps(connect_frame))
        websocket.receive_text()

        # Send unknown method
        unknown_frame = {
            "type": "request",
            "id": "unknown-1",
            "method": "nonexistent_method",
            "params": {},
        }
        websocket.send_text(json.dumps(unknown_frame))

        # Receive error response
        response = websocket.receive_text()
        data = json.loads(response)

        assert data["type"] == "response"
        assert data["id"] == "unknown-1"
        assert "error" in data
        assert data["error"]["code"] == "method_not_found"


def test_websocket_invalid_frame(client):
    """Test WebSocket with invalid frame format."""
    with client.websocket_connect("/ws") as websocket:
        # Connect
        connect_frame = {
            "type": "request",
            "id": "connect",
            "method": "connect",
            "params": {},
        }
        websocket.send_text(json.dumps(connect_frame))
        websocket.receive_text()

        # Send invalid JSON
        websocket.send_text("invalid json {{{")

        # Receive error response
        response = websocket.receive_text()
        data = json.loads(response)

        assert data["type"] == "response"
        assert "error" in data
        assert data["error"]["code"] == "invalid_frame"


def test_websocket_multiple_clients(client):
    """Test multiple WebSocket clients connecting."""
    manager = get_connection_manager()

    with client.websocket_connect("/ws") as ws1:
        # Connect client 1
        ws1.send_text(
            json.dumps(
                {
                    "type": "request",
                    "id": "connect",
                    "method": "connect",
                    "params": {"client_id": "client-1"},
                }
            )
        )
        ws1.receive_text()

        with client.websocket_connect("/ws") as ws2:
            # Connect client 2
            ws2.send_text(
                json.dumps(
                    {
                        "type": "request",
                        "id": "connect",
                        "method": "connect",
                        "params": {"client_id": "client-2"},
                    }
                )
            )
            ws2.receive_text()

            # Should have 2 connections
            assert manager.get_connection_count() >= 2


def test_websocket_invalid_connect_frame(client):
    """Test WebSocket with invalid connect frame closes connection."""
    with pytest.raises(Exception):  # Connection will be closed
        with client.websocket_connect("/ws") as websocket:
            # Send invalid connect (wrong method)
            invalid_connect = {
                "type": "request",
                "id": "1",
                "method": "ping",  # Should be "connect"
                "params": {},
            }
            websocket.send_text(json.dumps(invalid_connect))

            # Connection should be closed
            # This will raise an exception
            websocket.receive_text()
