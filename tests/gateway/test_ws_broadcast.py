"""Tests for WebSocket broadcast utilities."""

import pytest
from unittest.mock import AsyncMock, Mock

from openclaw_py.gateway.ws_broadcast import (
    broadcast_event,
    send_response_to_client,
    send_to_client,
)
from openclaw_py.gateway.ws_types import ConnectionState, WebSocketClient


@pytest.fixture
def mock_websocket():
    """Create a mock WebSocket."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


@pytest.fixture
def mock_client():
    """Create a mock WebSocket client."""
    return WebSocketClient(
        conn_id="test-conn-1",
        client_id="test-client",
        connected_at=1700000000,
    )


@pytest.fixture
def mock_connection(mock_websocket, mock_client):
    """Create a mock connection state."""
    return ConnectionState(
        websocket=mock_websocket,
        client=mock_client,
    )


@pytest.mark.asyncio
async def test_send_to_client_success(mock_websocket):
    """Test sending message to client successfully."""
    result = await send_to_client(
        mock_websocket,
        '{"type":"event"}',
        "conn-1",
    )

    assert result is True
    mock_websocket.send_text.assert_called_once_with('{"type":"event"}')


@pytest.mark.asyncio
async def test_send_to_client_failure(mock_websocket):
    """Test sending message to client with failure."""
    mock_websocket.send_text.side_effect = Exception("Connection closed")

    result = await send_to_client(
        mock_websocket,
        '{"type":"event"}',
        "conn-1",
    )

    assert result is False


@pytest.mark.asyncio
async def test_send_response_to_client(mock_websocket):
    """Test sending response to client."""
    result = await send_response_to_client(
        mock_websocket,
        '{"type":"response","id":"1"}',
        "conn-1",
    )

    assert result is True
    mock_websocket.send_text.assert_called_once()


@pytest.mark.asyncio
async def test_broadcast_event_no_connections():
    """Test broadcasting with no connections."""
    count = await broadcast_event(
        "test.event",
        {"data": "value"},
        connections=None,
    )

    assert count == 0


@pytest.mark.asyncio
async def test_broadcast_event_empty_connections():
    """Test broadcasting to empty connection set."""
    connections = set()
    count = await broadcast_event(
        "test.event",
        {"data": "value"},
        connections=connections,
    )

    assert count == 0


@pytest.mark.asyncio
async def test_broadcast_event_single_client(mock_connection):
    """Test broadcasting to single client."""
    connections = {mock_connection}

    count = await broadcast_event(
        "test.event",
        {"data": "value"},
        connections=connections,
    )

    assert count == 1
    mock_connection.websocket.send_text.assert_called_once()


@pytest.mark.asyncio
async def test_broadcast_event_multiple_clients():
    """Test broadcasting to multiple clients."""
    # Create mock connections
    conn1 = ConnectionState(
        websocket=AsyncMock(),
        client=WebSocketClient(conn_id="conn-1", connected_at=1700000000),
    )
    conn2 = ConnectionState(
        websocket=AsyncMock(),
        client=WebSocketClient(conn_id="conn-2", connected_at=1700000001),
    )

    connections = {conn1, conn2}

    count = await broadcast_event(
        "multi.event",
        {"count": 2},
        connections=connections,
    )

    assert count == 2
    conn1.websocket.send_text.assert_called_once()
    conn2.websocket.send_text.assert_called_once()


@pytest.mark.asyncio
async def test_broadcast_event_removes_failed_clients():
    """Test that failed clients are removed from connection set."""
    # Create one working and one failing connection
    good_conn = ConnectionState(
        websocket=AsyncMock(),
        client=WebSocketClient(conn_id="good", connected_at=1700000000),
    )

    bad_ws = AsyncMock()
    bad_ws.send_text.side_effect = Exception("Connection closed")
    bad_conn = ConnectionState(
        websocket=bad_ws,
        client=WebSocketClient(conn_id="bad", connected_at=1700000001),
    )

    connections = {good_conn, bad_conn}

    count = await broadcast_event(
        "test.event",
        {},
        connections=connections,
        drop_if_slow=False,
    )

    # Only good connection should succeed
    assert count == 1
    # Bad connection should be removed
    assert bad_conn not in connections
    assert good_conn in connections


@pytest.mark.asyncio
async def test_broadcast_event_drop_if_slow():
    """Test drop_if_slow parameter."""
    slow_ws = AsyncMock()
    slow_ws.send_text.side_effect = Exception("Slow connection")
    slow_conn = ConnectionState(
        websocket=slow_ws,
        client=WebSocketClient(conn_id="slow", connected_at=1700000000),
    )

    connections = {slow_conn}

    count = await broadcast_event(
        "test.event",
        {},
        connections=connections,
        drop_if_slow=True,
    )

    # Should return 0 but not crash
    assert count == 0


@pytest.mark.asyncio
async def test_broadcast_event_skips_dead_connections():
    """Test that dead connections are skipped."""
    dead_conn = ConnectionState(
        websocket=AsyncMock(),
        client=WebSocketClient(conn_id="dead", connected_at=1700000000),
    )
    dead_conn.is_alive = False

    connections = {dead_conn}

    count = await broadcast_event(
        "test.event",
        {},
        connections=connections,
    )

    assert count == 0
    # Should remove dead connection
    assert dead_conn not in connections
